// Minimal typing for the bun:test surface these tests use. bun-types itself is not loaded here:
// combined with lib DOM (needed for the in-page snapshot code) it makes tsc run out of memory.
declare module 'bun:test' {
  type Fn = () => void | Promise<void>;
  type Suite = (name: string, fn: () => void) => void;
  export function test(name: string, fn: Fn, timeout?: number): void;
  export const describe: Suite & { skipIf(condition: boolean): Suite };
  export function beforeAll(fn: Fn, timeout?: number): void;
  export function afterAll(fn: Fn, timeout?: number): void;
  export function beforeEach(fn: Fn, timeout?: number): void;
  export function afterEach(fn: Fn, timeout?: number): void;
}
