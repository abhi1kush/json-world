import { describe, it, expect } from 'vitest';
import { DEFAULT_JAVA_OPTIONS, generateJava, toFieldName, toClassName, itemClassName, singularize, infer, merge, numberType, jacksonImplicitName, JavaOptions } from './java';
import { parse } from './json';

const gen = (json: unknown, o: Partial<JavaOptions> = {}) => {
  const r = generateJava(typeof json === 'string' ? json : JSON.stringify(json), o);
  if (!r.ok) throw new Error(r.message);
  return r;
};
const code = (json: unknown, o: Partial<JavaOptions> = {}) => gen(json, o).code;
const P = (s: string) => { const r = parse(s); if (!r.ok) throw new Error(); return r.node; };

describe('naming', () => {
  it.each([
    ['user_name', 'userName'], ['first-name', 'firstName'], ['Zip Code', 'zipCode'], ['URL', 'url'], ['HTTPStatus', 'httpStatus'],
    ['userID', 'userID'], ['UserName', 'userName'], ['1st', 'field1st'], ['2nd_place', 'field2ndPlace'], ['class', 'classValue'],
    ['new', 'newValue'], ['default', 'defaultValue'], ['_', 'field'], ['', 'field'], ['@type', 'type'], ['$ref', 'ref'], ['a.b.c', 'aBC'],
    ['ümlaut_key', 'ümlautKey'], ['  spaced  out ', 'spacedOut'], ['__private', 'private' + 'Value'], ['true', 'trueValue'], ['var', 'varValue'],
  ])('field %j -> %s', (k, n) => expect(toFieldName(k)).toBe(n));
  it.each([['user_profile', 'UserProfile'], ['address', 'Address'], ['1x', 'Type1x'], ['', 'Item'], ['http-headers', 'HttpHeaders']])('class %j -> %s', (k, n) => expect(toClassName(k)).toBe(n));
  it.each([['items', 'Item'], ['categories', 'Category'], ['addresses', 'Address'], ['boxes', 'Box'], ['people', 'Person'], ['children', 'Child'],
    ['order_lines', 'OrderLine'], ['status', 'StatusItem'], ['data', 'DataItem'], ['list', 'ListItem'], ['matches', 'Match'], ['buses', 'Bus'], ['userIds', 'UserId']])
  ('array item class %j -> %s', (k, n) => expect(itemClassName(k)).toBe(n));
  it('singularize', () => { expect(singularize('class')).toBeNull(); expect(singularize('keys')).toBe('key'); expect(singularize('Analyses')).toBe('Analysis'); });
  it('jackson implicit names', () => { expect(jacksonImplicitName('AB')).toBe('ab'); expect(jacksonImplicitName('UserName')).toBe('userName'); expect(jacksonImplicitName('URLPath')).toBe('urlpath'); });
  it('deduplicates fields after sanitizing', () => {
    const c = code({ user_name: 'a', userName: 'b', 'user-name': 'c' });
    expect(c).toContain('private String userName;');
    expect(c).toContain('private String userName2;');
    expect(c).toContain('private String userName3;');
    expect(c).toContain('@JsonProperty("user-name")');
  });
});

describe('type inference', () => {
  it('numbers', () => {
    expect(numberType('2147483647').k).toBe('int'); expect(numberType('2147483648').k).toBe('long'); expect(numberType('-2147483649').k).toBe('long');
    expect(numberType('9223372036854775807').k).toBe('long'); expect(numberType('9223372036854775808').k).toBe('bigint'); expect(numberType('1.0').k).toBe('double'); expect(numberType('1e3').k).toBe('double');
  });
  it('merge rules', () => {
    expect(merge({ k: 'int' }, { k: 'long' }).k).toBe('long');
    expect(merge({ k: 'int' }, { k: 'double' }).k).toBe('double');
    expect(merge({ k: 'bigint' }, { k: 'double' }).k).toBe('bigdec');
    expect(merge({ k: 'null' }, { k: 'string' }).k).toBe('string');
    expect(merge({ k: 'string' }, { k: 'int' }).k).toBe('any');
    expect(infer(P('[]'))).toEqual({ k: 'list', of: { k: 'empty' } });
  });
  it('maps JSON types to Java types', () => {
    const src = '{"s":"x","b":true,"i":1,"l":3000000000,"big":123456789012345678901234567890,"d":1.5,"n":null,"e":[],"m":[1,"a"],"ints":[1,2,3000000000],"nested":[[1,2],[3]],"deep":[[[true]]],"dl":[1,2.5]}';
    const out = code(src);
    for (const line of ['private String s;', 'private Boolean b;', 'private Integer i;', 'private Long l;', 'private BigInteger big;', 'private Double d;', 'private Object n;', 'private List<Object> e;', 'private List<Object> m;', 'private List<Long> ints;', 'private List<List<Integer>> nested;', 'private List<List<List<Boolean>>> deep;', 'private List<Double> dl;'])
      expect(out).toContain(line);
    expect(out).toContain('import java.math.BigInteger;');
    expect(out).toContain('import java.util.List;');
    expect(out).not.toContain('BigDecimal');
  });
  it('BigDecimal and primitives options', () => {
    const out = code('{"d":1.5,"b":true,"i":1,"n":null,"arr":[{"x":1},{"y":2}]}', { bigDecimal: true, primitives: true });
    expect(out).toContain('private BigDecimal d;'); expect(out).toContain('import java.math.BigDecimal;');
    expect(out).toContain('private boolean b;'); expect(out).toContain('private int i;');
    expect(out).toContain('private Object n;');
    expect(out).toContain('private Integer x;'); // nullable (missing in some elements) stays boxed
  });
  it('null merged with other samples', () => {
    expect(code('{"a":[{"v":null},{"v":"x"}]}')).toContain('private String v;');
  });
});

describe('classes', () => {
  it('nested objects become public static inner classes', () => {
    const r = gen({ user: { name: 'a', address: { city: 'c', geo: { lat: 1.5 } } } });
    expect(r.classes).toEqual(['Request', 'User', 'Address', 'Geo']);
    expect(r.code).toContain('public class Request {');
    expect(r.code).toContain('    public static class User {');
    expect(r.code).toContain('    public static class Geo {');
    expect(r.code).toContain('private User user;'); expect(r.code).toContain('private Address address;');
    expect(r.code.match(/^public class/gm)!.length).toBe(1);
  });
  it('arrays of objects merge keys into one class', () => {
    const r = gen({ items: [{ id: 1, name: 'a' }, { id: 3000000000, tags: ['x'] }, { name: null, extra: { k: true } }] });
    expect(r.classes).toEqual(['Request', 'Item', 'Extra']);
    expect(r.code).toContain('private List<Item> items;');
    for (const l of ['private Long id;', 'private String name;', 'private List<String> tags;', 'private Extra extra;']) expect(r.code).toContain(l);
  });
  it('dedupes class name clashes and avoids top/JDK names', () => {
    const r = gen({ request: { a: 1 }, data: { user: { x: 1 } }, user: { y: 'q' }, string: { z: 1 }, list: [{ a: 'b' }] }, { reuseClasses: false, mode: 'class' });
    expect(r.classes).toEqual(['Request', 'Request2', 'Data', 'User', 'User2', 'String2', 'ListItem']);
    expect(gen({ data: { a: 1 } }, { mode: 'lombok' }).classes).toEqual(['Request', 'Data2']);
  });
  it('reuses identical shapes when enabled', () => {
    const src = { billing: { street: 's', zip: '1' }, shipping: { street: 't', zip: '2' }, other: { street: 'u' } };
    expect(gen(src).classes).toEqual(['Request', 'Billing', 'Other']);
    expect(gen(src).code).toContain('private Billing shipping;');
    expect(gen(src, { reuseClasses: false }).classes).toEqual(['Request', 'Billing', 'Shipping', 'Other']);
  });
  it('top-level array input uses merged element', () => {
    const r = gen([{ a: 1 }, { b: 'x' }], { className: 'Row' });
    expect(r.classes).toEqual(['Row']);
    expect(r.code).toContain('private Integer a;'); expect(r.code).toContain('private String b;');
  });
  it('errors', () => {
    expect(generateJava('[1,2]')).toMatchObject({ ok: false });
    expect(generateJava('"x"')).toMatchObject({ ok: false });
    expect(generateJava('{"a":')).toMatchObject({ ok: false, line: 1 });
    expect(generateJava('{}', { packageName: 'com.1bad' })).toMatchObject({ ok: false });
    expect(generateJava('{}', { packageName: 'com.new.x' })).toMatchObject({ ok: false });
  });
  it('package, class name sanitizing, empty object', () => {
    const c = code('{"e":{}}', { packageName: 'com.example.dto', className: 'my order' });
    expect(c.startsWith('package com.example.dto;\n')).toBe(true);
    expect(c).toContain('public class myorder {');
    expect(c).toContain('private Map<String, Object> e;'); expect(c).toContain('import java.util.Map;');
  });
});

describe('modes and options', () => {
  it('defaults to Lombok with no hand-written accessors', () => {
    expect(DEFAULT_JAVA_OPTIONS.mode).toBe('lombok');
    expect(DEFAULT_JAVA_OPTIONS.gettersSetters).toBe(false);
    expect(DEFAULT_JAVA_OPTIONS.lombokBuilder).toBe(false);
    const c = code({ user_id: 1, items: [{ sku: 'a' }] });
    for (const a of ['@Data', '@NoArgsConstructor', '@AllArgsConstructor', 'import lombok.Data;']) expect(c).toContain(a);
    expect(c).not.toContain('@Builder');
    expect(c).not.toMatch(/public \S+ get\w+\(|public void set\w+\(/);
    expect(c.match(/@Data/g)!.length).toBe(2); // top + nested Item
    // plain mode still has no accessors unless asked for
    expect(code({ a: 1 }, { mode: 'class' })).not.toContain('getA()');
  });
  const src = { user_id: 1, isActive: true, aB: 'x', items: [{ sku: 'a', qty: 2 }] };
  it('plain class with getters/setters, constructors, toString/equals/hashCode', () => {
    const c = code(src, { mode: 'class', gettersSetters: true, toStringEqualsHashCode: true });
    expect(c).toContain('public Request() {');
    expect(c).toContain('public Request(Integer userId, Boolean isActive, String aB, List<Item> items) {');
    expect(c).toContain('public Integer getUserId() {'); expect(c).toContain('public void setUserId(Integer userId) {');
    expect(c).toContain('public boolean equals(Object o) {'); expect(c).toContain('Objects.hash(userId, isActive, aB, items)');
    expect(c).toContain('import java.util.Objects;');
    // getAB() would imply property "ab" for Jackson, so accessors are annotated
    expect(c).toMatch(/@JsonProperty\("aB"\)\n\s+public String getAB\(\)/);
  });
  it('without getters/constructors', () => {
    const c = code(src, { mode: 'class', gettersSetters: false, constructors: false });
    expect(c).not.toContain('get'); expect(c).not.toContain('public Request(');
  });
  it('lombok mode', () => {
    const c = code(src, { mode: 'lombok', lombokBuilder: true, toStringEqualsHashCode: true });
    for (const s of ['import lombok.Data;', '@Data', '@NoArgsConstructor', '@AllArgsConstructor', '@Builder']) expect(c).toContain(s);
    expect(c).not.toContain('public Integer getUserId');
    expect(c).not.toContain('equals(');
    expect(c).toContain('@JsonAutoDetect('); // because of aB
    expect(code({ a: 1 }, { mode: 'lombok' })).not.toContain('JsonAutoDetect');
    expect(code({}, { mode: 'lombok' })).not.toContain('@AllArgsConstructor'); // would clash with the no-arg constructor
  });
  it('record mode', () => {
    const c = code(src, { mode: 'record' });
    expect(c).toContain('public record Request(');
    expect(c).toContain('@JsonProperty("user_id") Integer userId,');
    expect(c).toContain('    public record Item(');
    expect(c).not.toContain('private ');
    expect(code('{}', { mode: 'record' })).toContain('public record Request() {}');
  });
  it('annotation toggles', () => {
    const c = code({ a: 1, n: { b: 2 } }, { ignoreUnknown: true, includeNonNull: true });
    expect(c.match(/@JsonIgnoreProperties\(ignoreUnknown = true\)/g)!.length).toBe(2);
    expect(c.match(/@JsonInclude\(JsonInclude.Include.NON_NULL\)/g)!.length).toBe(2);
    expect(c).toContain('import com.fasterxml.jackson.annotation.JsonInclude;');
  });
  it('keeps original keys in @JsonProperty with escaping', () => {
    const c = code({ 'we"ird\\key': 1, 'class': 'x', '2fa': true });
    expect(c).toContain('@JsonProperty("we\\"ird\\\\key")'); expect(c).toContain('private String classValue;'); expect(c).toContain('private Boolean field2fa;');
  });
});
