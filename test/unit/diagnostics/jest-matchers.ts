// Jest custom matchers for diagnostic tests

interface CustomMatchers<R = unknown> {
  toBeOneOf(expected: any[]): R;
}

declare global {
  namespace jest {
    interface Expect extends CustomMatchers {}
    interface Matchers<R> extends CustomMatchers<R> {}
    interface InverseAsymmetricMatchers extends CustomMatchers {}
  }
}

// Use require to access Jest's expect
const jestExpect = require('expect');

jestExpect.extend({
  toBeOneOf(received: any, expected: any[]) {
    const pass = expected.includes(received);
    
    if (pass) {
      return {
        message: () => `expected ${received} not to be one of ${expected.join(', ')}`,
        pass: true,
      };
    } else {
      return {
        message: () => `expected ${received} to be one of ${expected.join(', ')}`,
        pass: false,
      };
    }
  },
});

export {};
