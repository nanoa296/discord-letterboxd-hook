const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { loadStack } = require('../../tests/pulumi-mocks.cjs');

test('GCP scheduler invokes the underlying Cloud Run service with OIDC', async () => {
  await loadStack(path.resolve(__dirname, '..'), 'pulumi-gcp.ts', {
    'gcp:project': 'test-gcp-project',
    'test-project:username': 'test-user',
    'test-project:discordWebhookUrl': 'https://example.invalid/webhook',
  }, args => ({
    name: args.inputs.name || args.name,
    email: `${args.name}@example.invalid`,
    generation: 42,
    ...(args.name === 'letterboxdFunction' ? { serviceConfig: {
      ...args.inputs.serviceConfig,
      service: 'projects/test-gcp-project/locations/us-central1/services/actual-service-name',
      uri: 'https://actual-service-name.example.invalid',
    } } : {}),
  }), async resources => {
    const get = name => resources.find(resource => resource.name === name);
    const invoker = get('schedulerInvoker');
    assert.equal(invoker.type, 'gcp:cloudrun/iamMember:IamMember');
    assert.equal(invoker.state.service, 'actual-service-name');
    assert.equal(invoker.state.role, 'roles/run.invoker');
    const job = get('letterboxdScheduler').state;
    assert.equal(job.httpTarget.uri, 'https://actual-service-name.example.invalid');
    assert.equal(job.httpTarget.oidcToken.audience, job.httpTarget.uri);
    assert.equal(job.httpTarget.oidcToken.serviceAccountEmail, 'letterboxdSchedulerSa@example.invalid');
    const fn = get('letterboxdFunction').state;
    assert.equal(fn.buildConfig.runtime, 'nodejs24');
    assert.equal(fn.buildConfig.source.storageSource.generation, 42);
    for (const name of ['letterboxdStateBucket', 'letterboxdCodeBucket', 'letterboxdFunction', 'letterboxdScheduler']) {
      assert.match(get(name).state.name, /-[0-9a-f]{10}$/);
    }
  });
});
