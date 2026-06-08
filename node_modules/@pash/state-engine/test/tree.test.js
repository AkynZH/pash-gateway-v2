'use strict';

const { ComponentTree } = require('../src/tree');

describe('ComponentTree — mount', () => {
  test('mounts root element', () => {
    const tree = new ComponentTree();
    const r = tree.mount({ id: 'root', component: 'Panel', fields: { title: 'Main' } });
    expect(r.ok).toBe(true);
    expect(tree.has('root')).toBe(true);
    expect(tree.get('root').component).toBe('Panel');
  });

  test('mounts child with parent', () => {
    const tree = new ComponentTree();
    tree.mount({ id: 'root', component: 'Panel', fields: {} });
    const r = tree.mount({ id: 'card1', component: 'ProductCard', fields: {}, parent: 'root' });
    expect(r.ok).toBe(true);
    expect(tree.get('card1').parent).toBe('root');
  });

  test('duplicate ID fails', () => {
    const tree = new ComponentTree();
    tree.mount({ id: 'a', component: 'X', fields: {} });
    const r = tree.mount({ id: 'a', component: 'Y', fields: {} });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/already exists/);
  });

  test('non-existent parent fails', () => {
    const tree = new ComponentTree();
    const r = tree.mount({ id: 'child', component: 'X', fields: {}, parent: 'ghost' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/);
  });
});

describe('ComponentTree — update', () => {
  test('updates field value', () => {
    const tree = new ComponentTree();
    tree.mount({ id: 'x', component: 'Badge', fields: { text: 'old' } });
    const r = tree.update('x', 'text', 'new');
    expect(r.ok).toBe(true);
    expect(r.prev).toBe('old');
    expect(tree.get('x').fields.text).toBe('new');
  });

  test('update non-existent element fails', () => {
    const tree = new ComponentTree();
    const r = tree.update('ghost', 'field', 'val');
    expect(r.ok).toBe(false);
  });
});

describe('ComponentTree — unmount (cascade)', () => {
  function buildTree() {
    const tree = new ComponentTree();
    tree.mount({ id: 'panel',   component: 'Panel',       fields: {} });
    tree.mount({ id: 'list',    component: 'List',         fields: {}, parent: 'panel' });
    tree.mount({ id: 'card1',   component: 'ProductCard',  fields: {}, parent: 'list' });
    tree.mount({ id: 'card2',   component: 'ProductCard',  fields: {}, parent: 'list' });
    tree.mount({ id: 'notif',   component: 'Notification', fields: {}, parent: 'panel' });
    return tree;
  }

  test('unmount leaf — only removes leaf', () => {
    const tree = buildTree();
    const r = tree.unmount('card1');
    expect(r.ok).toBe(true);
    expect(r.removed).toEqual(['card1']);
    expect(tree.has('card1')).toBe(false);
    expect(tree.has('card2')).toBe(true);
  });

  test('cascade: unmount parent removes all descendants', () => {
    const tree = buildTree();
    const r = tree.unmount('panel');
    expect(r.ok).toBe(true);
    expect(r.removed).toContain('panel');
    expect(r.removed).toContain('list');
    expect(r.removed).toContain('card1');
    expect(r.removed).toContain('card2');
    expect(r.removed).toContain('notif');
    expect(tree.size).toBe(0);
  });

  test('unmount non-existent ID — idempotent with warning', () => {
    const tree = new ComponentTree();
    const r = tree.unmount('ghost');
    expect(r.ok).toBe(true);
    expect(r.removed).toHaveLength(0);
    expect(r.warning).toMatch(/idempotent/);
  });

  test('after cascade: parent children index is clean', () => {
    const tree = buildTree();
    tree.unmount('list');
    // Re-mounting to list's old parent should still work
    const r = tree.mount({ id: 'new_item', component: 'X', fields: {}, parent: 'panel' });
    expect(r.ok).toBe(true);
  });
});

describe('ComponentTree — snapshot', () => {
  test('snapshot produces consistent SHA-256 hash', () => {
    const tree = new ComponentTree();
    tree.mount({ id: 'a', component: 'Badge', fields: { text: 'hello' } });
    const s1 = tree.snapshot();
    const s2 = tree.snapshot();
    expect(s1.hash).toBe(s2.hash);
    expect(s1.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test('different trees produce different hashes', () => {
    const t1 = new ComponentTree();
    const t2 = new ComponentTree();
    t1.mount({ id: 'a', component: 'Badge', fields: { text: 'hello' } });
    t2.mount({ id: 'a', component: 'Badge', fields: { text: 'world' } });
    expect(t1.snapshot().hash).not.toBe(t2.snapshot().hash);
  });

  test('restore from snapshot → same hash', () => {
    const t1 = new ComponentTree();
    t1.mount({ id: 'root', component: 'Panel', fields: {} });
    t1.mount({ id: 'card', component: 'ProductCard', fields: { title: 'X' }, parent: 'root' });
    const snap = t1.snapshot();

    const t2 = new ComponentTree();
    t2.restoreFromSnapshot(snap);
    expect(t2.snapshot().hash).toBe(snap.hash);
  });

  test('verifyHash: correct hash returns true', () => {
    const tree = new ComponentTree();
    tree.mount({ id: 'x', component: 'Badge', fields: {} });
    const { hash } = tree.snapshot();
    expect(tree.verifyHash(hash)).toBe(true);
  });

  test('verifyHash: wrong hash returns false', () => {
    const tree = new ComponentTree();
    tree.mount({ id: 'x', component: 'Badge', fields: {} });
    expect(tree.verifyHash('wrong_hash')).toBe(false);
  });
});

describe('ComponentTree — applyOp', () => {
  test('applyOp MOUNT', () => {
    const tree = new ComponentTree();
    const r = tree.applyOp({ type: '+', id: 'a', component: 'Badge',
                             fields: {}, rawFields: [], parent: null, namedParams: {} });
    expect(r.ok).toBe(true);
    expect(r.errorLine).toBeNull();
  });

  test('applyOp UPDATE', () => {
    const tree = new ComponentTree();
    tree.mount({ id: 'a', component: 'Badge', fields: { text: 'old' } });
    const r = tree.applyOp({ type: '~', id: 'a', field: 'text', value: 'new' });
    expect(r.ok).toBe(true);
  });

  test('applyOp UNMOUNT cascade', () => {
    const tree = new ComponentTree();
    tree.mount({ id: 'p', component: 'Panel', fields: {} });
    tree.mount({ id: 'c', component: 'Card',  fields: {}, parent: 'p' });
    const r = tree.applyOp({ type: '-', id: 'p' });
    expect(r.removed).toContain('c');
  });

  test('applyOp error produces !error line', () => {
    const tree = new ComponentTree();
    const r = tree.applyOp({ type: '~', id: 'ghost', field: 'x', value: 'y' });
    expect(r.ok).toBe(false);
    expect(r.errorLine).toMatch(/^!error\|/);
  });
});
