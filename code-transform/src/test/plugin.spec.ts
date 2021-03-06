import pluginTester from 'babel-plugin-tester';
import plugin from '../';

pluginTester({
  plugin,
  pluginName: '@reshuffle/backend-babel-plugin',
  tests: {
    'Mark @exposed functions as exposed': {
      code: `
        // @expose
        export async function hello() {
          return 42;
        }
      `,
      output: `
        // @expose
        export async function hello() {
          return 42;
        }
        hello.__reshuffle__ = {
          exposed: true
        };
      `,
    },
    'Mark @exposed TypeScript output functions as exposed': {
      code: `
        // @expose
        function hello() {
          return 42;
        }
        exports.hello = hello;
      `,
      output: `
        // @expose
        function hello() {
          return 42;
        }

        hello.__reshuffle__ = {
          exposed: true
        };
        exports.hello = hello;
      `,
    },
  },
});
