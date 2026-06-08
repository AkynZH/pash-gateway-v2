'use strict';

const { serializeOp, serializeStream } = require('../src/serializer');
const { parseLine, parseStream }       = require('../src/parser');

describe('serializeOp — MOUNT', () => {
  test('basic without parent', () => {
    const op = { type: '+', id: 'card1', component: 'ProductCard',
                 rawFields: ['X1', 'AMOLED', '69990', 'Купить'], parent: null, namedParams: {} };
    expect(serializeOp(op)).toBe('+[card1]|ProductCard|X1|AMOLED|69990|Купить');
  });

  test('with @parent', () => {
    const op = { type: '+', id: 'u1', component: 'UserCard',
                 rawFields: ['Felix', 'Dev'], parent: 'panel', namedParams: {} };
    expect(serializeOp(op)).toContain('@parent=panel');
  });

  test('pipe in field escaped', () => {
    const op = { type: '+', id: 'a', component: 'Badge',
                 rawFields: ['Fast|Reliable'], parent: null, namedParams: {} };
    expect(serializeOp(op)).toContain('Fast\\|Reliable');
  });
});

describe('serializeOp — UPDATE / UNMOUNT / ERROR', () => {
  test('UPDATE', () => {
    expect(serializeOp({ type: '~', id: 'x', field: 'status', value: 'Active' }))
      .toBe('~[x]|status|Active');
  });

  test('UNMOUNT', () => {
    expect(serializeOp({ type: '-', id: 'list' })).toBe('-[list]');
  });

  test('ERROR', () => {
    const line = serializeOp({ type: '!', level: 'error',
                               params: { id: 'x', reason: 'missing' } });
    expect(line).toMatch(/^!error\|/);
    expect(line).toContain('id=x');
  });
});

describe('serializeStream', () => {
  test('adds v:2 header', () => {
    const ops = [{ type: '+', id: 'a', component: 'Badge',
                   rawFields: ['text'], parent: null, namedParams: {} }];
    expect(serializeStream(ops, '2')).toMatch(/^v:2\n/);
  });
});

describe('round-trip: parse → serialize → parse', () => {
  test('MOUNT preserves id, component, parent', () => {
    const line    = '+[usr_1]|UserCard|Felix|Dev|@parent=panel';
    const op      = parseLine(line);
    const op2     = parseLine(serializeOp(op));
    expect(op2.id).toBe('usr_1');
    expect(op2.component).toBe('UserCard');
    expect(op2.parent).toBe('panel');
  });

  test('full stream preserves op types and IDs', () => {
    const stream = `v:2
+[p]|Panel|Main
+[c]|ProductCard|X1|AMOLED|69990|Купить|@parent=p
~[c]|price|59990
-[c]`;
    const { ops }        = parseStream(stream);
    const reserialized   = serializeStream(ops, '2');
    const { ops: ops2 }  = parseStream(reserialized);
    expect(ops2).toHaveLength(4);
    ops2.forEach((o, i) => {
      expect(o.type).toBe(ops[i].type);
      expect(o.id).toBe(ops[i].id);
    });
  });
});
