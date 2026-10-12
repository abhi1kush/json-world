import { describe, it, expect } from 'vitest';
import { diffLines } from 'diff';
import { parse, JNode } from './json';
import { diff, summarize, listDiffs, canonicalNumber, diffText, sideBySide } from './diff';

const P = (s: string): JNode => { const r = parse(s); if (!r.ok) throw new Error(r.error.message); return r.node; };
const D = (a: string, b: string, o = {}) => diff(P(a), P(b), o);
const paths = (a: string, b: string, o = {}) => listDiffs(D(a, b, o)).map(d => `${d.kind}:${JSON.stringify(d.path)}`);

describe('diff', () => {
  it('identical docs have no differences', () => {
    const d = D('{"a":[1,{"b":null}]}', '{"a":[1,{"b":null}]}');
    expect(d.kind).toBe('same'); expect(d.count).toBe(0);
    expect(summarize(d)).toEqual({ added: 0, removed: 0, changed: 0, total: 0 });
  });
  it('nested added / removed / changed with counts', () => {
    const d = D('{"a":{"b":1,"c":2,"d":{"e":true}}}', '{"a":{"b":1,"c":3,"d":{"e":true,"f":"x"}},"g":[]}');
    expect(paths('{"a":{"b":1,"c":2,"d":{"e":true}}}', '{"a":{"b":1,"c":3,"d":{"e":true,"f":"x"}},"g":[]}'))
      .toEqual(['changed:["a","c"]', 'added:["a","d","f"]', 'added:["g"]']);
    expect(d.count).toBe(3);
    expect(d.children![0].node.count).toBe(2);
    expect(summarize(d)).toEqual({ added: 2, removed: 0, changed: 1, total: 3 });
  });
  it('removed subtrees are browsable and count as one', () => {
    const d = D('{"x":{"y":[1,2]}}', '{}');
    expect(d.count).toBe(1);
    const x = d.children![0].node;
    expect(x.kind).toBe('removed'); expect(x.children![0].node.children!.length).toBe(2);
  });
  it('arrays by index', () => {
    expect(paths('[1,2,3]', '[1,3]')).toEqual(['changed:[1]', 'removed:[2]']);
    expect(paths('[]', '[{"a":1}]')).toEqual(['added:[0]']);
  });
  it('type changes are a single change, not recursed', () => {
    expect(paths('{"a":{"b":1}}', '{"a":[1]}')).toEqual(['changed:["a"]']);
    expect(paths('{"a":"1"}', '{"a":1}')).toEqual(['changed:["a"]']);
    expect(paths('[0]', '[false]')).toEqual(['changed:[0]']);
  });
  it('null vs missing are different', () => {
    expect(paths('{"a":null}', '{}')).toEqual(['removed:["a"]']);
    expect(paths('{}', '{"a":null}')).toEqual(['added:["a"]']);
    expect(paths('{"a":null}', '{"a":0}')).toEqual(['changed:["a"]']);
    expect(paths('{"a":null}', '{"a":null}')).toEqual([]);
  });
  it('key order ignored by default, reported when toggled', () => {
    expect(paths('{"a":1,"b":2}', '{"b":2,"a":1}')).toEqual([]);
    const d = D('{"a":1,"b":2}', '{"b":2,"a":1}', { ignoreKeyOrder: false });
    expect(d.orderChanged).toBe(true); expect(d.count).toBe(1);
    expect(summarize(d).changed).toBe(1);
    expect(D('{"a":1,"b":2,"c":3}', '{"a":1,"c":3}', { ignoreKeyOrder: false }).orderChanged).toBeUndefined();
  });
  it('match array items by key field', () => {
    const a = '[{"id":1,"n":"a"},{"id":2,"n":"b"},{"id":3,"n":"c"}]';
    const b = '[{"id":3,"n":"c"},{"id":1,"n":"A"},{"id":4,"n":"d"}]';
    expect(paths(a, b, { arrayKey: 'id' })).toEqual(['changed:[0,"n"]', 'removed:[1]', 'added:[2]']);
    expect(paths(a, b).length).toBeGreaterThan(3); // by index everything shifts
    const d = D(a, b, { arrayKey: 'id' });
    expect(d.children![0]).toMatchObject({ leftSeg: 0, rightSeg: 1 });
  });
  it('match-by-key falls back to index when key missing or duplicated', () => {
    expect(paths('[{"id":1},{"x":2}]', '[{"x":2},{"id":1}]', { arrayKey: 'id' }).length).toBe(4);
    expect(paths('[{"id":1,"v":1},{"id":1,"v":2}]', '[{"id":1,"v":1},{"id":1,"v":3}]', { arrayKey: 'id' })).toEqual(['changed:[1,"v"]']);
    expect(paths('[{"id":"1"}]', '[{"id":1}]', { arrayKey: 'id' })).toEqual(['removed:[0]', 'added:[0]']);
  });
  it('numbers compared exactly by value', () => {
    expect(paths('[1, 1.0, 100, 12345678901234567890]', '[1.0, 1e0, 1e2, 12345678901234567890]')).toEqual([]);
    expect(paths('[12345678901234567890]', '[12345678901234567891]')).toEqual(['changed:[0]']);
    expect(canonicalNumber('-0.0012e3')).toBe('-12e-1');
    expect(canonicalNumber('0.000')).toBe('0');
  });
  it('root primitives', () => {
    expect(D('1', '2').kind).toBe('changed');
    expect(D('"a"', '"a"').kind).toBe('same');
  });
});

describe('line diff', () => {
  it('builds aligned side-by-side rows', () => {
    const a = diffText(P('{"b":1,"a":[1,2]}')), b = diffText(P('{"a":[1,3],"b":1,"c":true}'));
    const rows = sideBySide(diffLines(a, b));
    expect(rows.filter(r => r.kind !== 'same').length).toBeGreaterThan(0);
    expect(rows.filter(r => r.left).map(r => r.left!.text).join('\n')).toBe(a);
    expect(rows.filter(r => r.right).map(r => r.right!.text).join('\n')).toBe(b);
    expect(rows.find(r => r.kind === 'changed')).toMatchObject({ left: { text: '    2' }, right: { text: '    3' } });
  });
  it('diffText sorts keys only when ignoring order', () => {
    expect(diffText(P('{"b":1,"a":2}'))).toBe('{\n  "a": 2,\n  "b": 1\n}');
    expect(diffText(P('{"b":1,"a":2}'), { ignoreKeyOrder: false })).toBe('{\n  "b": 1,\n  "a": 2\n}');
  });
});

import { sortArraysDeep, canonicalString, compareCodePoints } from './diff';
import { stringify } from './json';
const S = (s: string) => stringify(sortArraysDeep(P(s)), 0);

describe('sort arrays before compare', () => {
  it('sorts bottom-up: inner sort changes the outer order', () => {
    // Sorting the outer array first would compare "[2,5]" < "[9,1]" and keep this order;
    // bottom-up sorts [9,1] -> [1,9] first, so "[1,9]" < "[2,5]" flips the outer order.
    expect(S('[[2,5],[9,1]]')).toBe('[[1,9],[2,5]]');
    expect(S('[[[3,0]],[[2,1]]]')).toBe('[[[0,3]],[[1,2]]]');
    expect(S('{"x":[{"v":[9,1]},{"v":[2,5]}]}')).toBe('{"x":[{"v":[1,9]},{"v":[2,5]}]}');
  });
  it('objects with different key orders sort identically and keep their own key order', () => {
    expect(S('[{"b":2,"a":1},{"a":0,"b":5}]')).toBe('[{"a":0,"b":5},{"b":2,"a":1}]');
    expect(canonicalString(P('{"b":2,"a":1}'))).toBe('{"a":1,"b":2}');
  });
  it('mixed types and duplicates (stable)', () => {
    expect(S('[true,"a",1,null,[0],{"k":1},-1,false,"a"]')).toBe('["a","a",-1,1,[0],false,null,true,{"k":1}]');
    expect(S('[2,1,2,1]')).toBe('[1,1,2,2]');
  });
  it('lexicographic on canonical text: 10 before 9, exact number text kept', () => {
    expect(S('[9,10,"9","10"]')).toBe('["10","9",10,9]');
    expect(S('[1.50,1.5,1e2]')).toBe('[1.5,1.50,1e2]');
  });
  it('code point order, not locale / UTF-16', () => {
    expect(S('["b","B","a","é","😀","\uffff"]')).toBe(JSON.stringify(['B', 'a', 'b', 'é', '\uffff', '😀']));
    expect(compareCodePoints('😀', '\uffff')).toBe(1);
  });
  it('default (sorted): permuted inputs => 0 diffs; check-order (unsorted): order differences reported', () => {
    const a = '{"users":[{"id":1,"tags":["x","y"]},{"id":2,"tags":["z"]}],"n":[3,1,2]}';
    const b = '{"n":[2,3,1],"users":[{"tags":["z"],"id":2},{"tags":["y","x"],"id":1}]}';
    expect(diff(sortArraysDeep(P(a)), sortArraysDeep(P(b))).count).toBe(0);
    const unsorted = listDiffs(diff(P(a), P(b))).map(d => JSON.stringify(d.path));
    expect(unsorted).toContain('["n",0]'); expect(unsorted.length).toBeGreaterThan(3);
    expect(diff(sortArraysDeep(P('[1,2]')), sortArraysDeep(P('[2,3]'))).count).toBe(2);
  });
  it('does not mutate input', () => {
    const n = P('[3,1]'); sortArraysDeep(n); expect(stringify(n, 0)).toBe('[3,1]');
  });
});
