const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const test = require('node:test');
const appRequire = createRequire(path.resolve(__dirname, '../../app/package.json'));

test('updated cloud SDKs load through CommonJS on the supported Node runtime', () => {
  const { SSMClient } = appRequire('@aws-sdk/client-ssm');
  const { BlobServiceClient } = appRequire('@azure/storage-blob');
  const { Storage } = appRequire('@google-cloud/storage');
  const ssm = new SSMClient({ region: 'us-east-1' });
  ssm.destroy();
  assert.ok(new BlobServiceClient('https://example.invalid').getContainerClient('test'));
  assert.equal(new Storage({ projectId: 'test-project' }).bucket('test-bucket').name, 'test-bucket');
  for (const parent of ['gaxios', 'teeny-request']) {
    const parentRequire = createRequire(appRequire.resolve(parent));
    assert.match(parentRequire('uuid').v4(), /^[0-9a-f-]{36}$/);
    assert.match(parentRequire('uuid/package.json').version, /^11\./);
  }
});

test('RSS parser still reads diary titles, dates, and content', async () => {
  const Parser = appRequire('rss-parser');
  const feed = await new Parser().parseString(`<rss version="2.0"><channel>
    <title>Diary</title><link>https://letterboxd.com/test/</link><description>Test</description>
    <item><title>Test Film - ★★★★</title><link>https://letterboxd.com/test/film/test/</link>
    <pubDate>Thu, 22 Oct 2026 12:00:00 GMT</pubDate><description><![CDATA[Watched on October 22, 2026.]]></description></item>
  </channel></rss>`);
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].title, 'Test Film - ★★★★');
  assert.equal(feed.items[0].isoDate, '2026-10-22T12:00:00.000Z');
  assert.match(feed.items[0].content, /Watched on/);
});
