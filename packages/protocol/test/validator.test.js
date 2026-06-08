'use strict';

const { validate, validateSyntax, buildSchemaDowngradeWarn } = require('../src/validator');
const { parseLine } = require('../src/parser');

const SCHEMA_USERCARD = {
  fields: [
    { label: 'name',  type: 'string', required: true },
    { label: 'role',  type: 'string', required: true },
    { label: 'email', type: 'string', required: false },
  ],
};

const SCHEMA_NOTIFICATION = {
  fields: [
    { label: 'level',   type: 'enum', required: true, values: ['info','warn','error'] },
    { label: 'message', type: 'string', required: true },
  ],
};

describe('validateSyntax — Pass 1', () => {
  test('valid MOUNT passes', () => {
    const op = parseLine('+[a]|ProductCard|X|Y');
    expect(validateSyntax(op).valid).toBe(true);
  });

  test('invalid element ID fails', () => {
    const op = { type: '+', id: '123-invalid', component: 'Card', fields: {}, rawFields: [], parent: null };
    const r  = validateSyntax(op);
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/invalid element ID format/);
  });

  test('non-PascalCase component name fails', () => {
    const op = { type: '+', id: 'a', component: 'productCard', fields: {}, rawFields: [], parent: null };
    expect(validateSyntax(op).valid).toBe(false);
  });

  test('UPDATE with missing field fails', () => {
    const op = { type: '~', id: 'x', field: '', value: 'val' };
    expect(validateSyntax(op).valid).toBe(false);
  });

  test('UNMOUNT with missing ID fails', () => {
    const op = { type: '-', id: '' };
    expect(validateSyntax(op).valid).toBe(false);
  });

  test('PARSE_ERROR always invalid', () => {
    expect(validateSyntax({ type: 'PARSE_ERROR', reason: 'x' }).valid).toBe(false);
  });
});

describe('validate — Full two-pass', () => {
  const tree = {
    list_panel: { component: 'Panel', fields: {}, parent: null },
  };

  test('valid MOUNT with schema passes', () => {
    const op = parseLine('+[usr1]|UserCard|Felix|Dev|@parent=list_panel');
    op.fields = { name: 'Felix', role: 'Dev', email: '' };
    const r = validate(op, SCHEMA_USERCARD, tree, () => SCHEMA_USERCARD);
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  test('missing required field → semantic error', () => {
    const op = parseLine('+[usr2]|UserCard|Felix||@parent=list_panel');
    op.fields = { name: 'Felix', role: '', email: '' };
    const r = validate(op, SCHEMA_USERCARD, tree, () => SCHEMA_USERCARD);
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('role'))).toBe(true);
    expect(r.errorLine).toMatch(/^!error\|/);
  });

  test('invalid enum value → semantic error', () => {
    const op = { type: '+', id: 'n1', component: 'Notification',
                 fields: { level: 'critical', message: 'Oops' },
                 rawFields: ['critical', 'Oops'], parent: null, namedParams: {} };
    const r = validate(op, SCHEMA_NOTIFICATION, tree);
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/not in allowed values/);
  });

  test('MOUNT with non-existent parent → semantic error', () => {
    const op = { type: '+', id: 'x', component: 'UserCard',
                 fields: { name: 'A', role: 'B', email: '' },
                 rawFields: [], parent: 'non_existent', namedParams: {} };
    const r = validate(op, SCHEMA_USERCARD, tree);
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/Parent.*not found/);
  });

  test('MOUNT duplicate ID → semantic error', () => {
    const op = { type: '+', id: 'list_panel', component: 'Panel',
                 fields: {}, rawFields: [], parent: null, namedParams: {} };
    const r = validate(op, null, tree);
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/already exists/);
  });

  test('UNMOUNT non-existent ID → warning, not error', () => {
    const op = { type: '-', id: 'ghost_element' };
    const r  = validate(op, null, tree);
    expect(r.valid).toBe(true);
    expect(r.warnings[0]).toMatch(/not found.*idempotent/);
    expect(r.errorLine).toMatch(/^!warn\|/);
  });

  test('UPDATE non-existent field → semantic error', () => {
    const treeWithElem = {
      ...tree,
      usr_x: { component: 'UserCard', fields: {}, parent: null },
    };
    const op = { type: '~', id: 'usr_x', field: 'non_existent_field', value: 'v' };
    const r  = validate(op, null, treeWithElem, () => SCHEMA_USERCARD);
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/does not exist in schema/);
  });
});

describe('buildSchemaDowngradeWarn', () => {
  test('produces !warn line with dropped fields', () => {
    const line = buildSchemaDowngradeWarn('usr_402', ['sustainability_score', 'carbon_footprint']);
    expect(line).toBe('!warn|id=usr_402|reason=schema_downgrade|dropped_fields=sustainability_score,carbon_footprint');
  });
});
