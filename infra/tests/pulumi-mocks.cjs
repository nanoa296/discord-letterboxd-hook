const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

exports.loadStack = async function (directory, filename, config, mockState, check) {
  const localRequire = createRequire(path.join(directory, 'package.json'));
  const pulumi = localRequire('@pulumi/pulumi');
  const ts = localRequire('typescript');
  process.env.PULUMI_CONFIG = JSON.stringify(config);
  const resources = [];
  pulumi.runtime.setMocks({
    newResource(args) {
      args.inputs = unsecret(args.inputs);
      const state = { ...args.inputs, ...mockState(args) };
      resources.push({ ...args, state });
      return { id: `${args.name}-id`, state };
    },
    call(args) {
      if (args.token.includes('listStorageAccountKeys')) return { keys: [{ value: 'test-key' }] };
      if (args.token.includes('getClientConfig')) return { subscriptionId: 'test-subscription' };
      if (args.token.includes('getProject')) return { number: '123456789', ...args.inputs };
      return args.inputs;
    },
  }, 'test-project', 'test-stack', false);
  require.extensions['.ts'] = (module, file) => {
    module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText, file);
  };
  await pulumi.runtime.runInPulumiStack(async () => {
    const stack = require(path.join(directory, filename));
    await Promise.all(Object.values(stack).map(value => pulumi.output(value).promise()));

  });
  await check(resources);
};

function unsecret(value) {
  if (!value || typeof value !== "object") return value;
  if (value["4dabf18193072939515e22adb298388d"] && "value" in value) return unsecret(value.value);
  if (Array.isArray(value)) return value.map(unsecret);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unsecret(item)]));
}
