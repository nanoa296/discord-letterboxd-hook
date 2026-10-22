const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { loadStack } = require('../../tests/pulumi-mocks.cjs');

test('Azure uses supported Linux hosting and non-expiring private package access', async () => {
  await loadStack(path.resolve(__dirname, '..'), 'pulumi-azure.ts', {
    'test-project:username': 'test-user',
    'test-project:discordWebhookUrl': 'https://example.invalid/webhook',
  }, args => ({
    name: args.inputs.name || args.inputs.accountName || args.inputs.containerName || args.inputs.blobName || args.name,
    principalId: 'test-principal',
  }), async resources => {
    const get = name => resources.find(resource => resource.name === name).state;
    const storage = get('letterboxdStorage');
    assert.match(storage.accountName, /^[a-z0-9]{3,24}$/);
    const plan = get('letterboxdPlan');
    assert.equal(plan.reserved, true);
    assert.equal(plan.sku.name, 'Y1');
    const app = get('letterboxdFunction');
    assert.equal(app.kind, 'functionapp,linux');
    assert.equal(app.siteConfig.linuxFxVersion, 'NODE|22');
    const settings = Object.fromEntries(app.siteConfig.appSettings.map(({ name, value }) => [name, value]));
    assert.equal(settings.FUNCTIONS_EXTENSION_VERSION, '~4');
    assert.equal(new URL(settings.WEBSITE_RUN_FROM_PACKAGE).search, '');
    assert.equal(settings.WEBSITE_RUN_FROM_PACKAGE_BLOB_MI_RESOURCE_ID, 'letterboxdPackageIdentity-id');
    assert.deepEqual(app.identity.userAssignedIdentities, ['letterboxdPackageIdentity-id']);
    const role = get('letterboxdPackageReader');
    assert.equal(role.scope, 'letterboxdCodeContainer-id');
    assert.equal(role.principalId, 'test-principal');
    assert.match(role.roleDefinitionId, /2a2b9908-6ea1-4ae2-8e65-a410df84e7d1$/);
  });
});
