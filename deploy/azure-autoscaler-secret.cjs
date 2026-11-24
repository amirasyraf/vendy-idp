// Runs in the pulled IDP image on the IDP host. Stdout goes only to kubectl.
const { createRequire } = require('node:module');
const { resolve } = require('node:path');

async function main() {
  const requireBackend = createRequire(
    resolve(__dirname, '../packages/backend/package.json'),
  );
  const requirePlugin = createRequire(
    requireBackend.resolve('@internal/plugin-cf-backend'),
  );
  const { GetSecretValueCommand, SecretsManagerClient } = requirePlugin(
    '@aws-sdk/client-secrets-manager',
  );
  const [clientId, tenantId, subscriptionId, resourceGroup] = process.argv.slice(2);
  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION,
    maxAttempts: 3,
  });
  try {
    const result = await client.send(
      new GetSecretValueCommand({ SecretId: process.env.AZURE_READER_SECRET_ID }),
      { abortSignal: AbortSignal.timeout(30_000) },
    );
    const value = JSON.parse(result.SecretString);
    if (
      value.clientId !== clientId ||
      value.tenantId !== tenantId ||
      value.subscriptionId !== subscriptionId ||
      typeof value.certificatePem !== 'string' ||
      !value.certificatePem.includes('-----BEGIN CERTIFICATE-----') ||
      !/-----BEGIN (RSA )?PRIVATE KEY-----/.test(value.certificatePem)
    ) {
      throw new Error('Unexpected Azure Reader secret');
    }
    process.stdout.write(
      JSON.stringify({
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: 'cluster-autoscaler-azure', namespace: 'kube-system' },
        type: 'Opaque',
        data: Object.fromEntries(
          Object.entries({
            ClientID: clientId,
            TenantID: tenantId,
            SubscriptionID: subscriptionId,
            ResourceGroup: resourceGroup,
            'cert.pem': value.certificatePem,
          }).map(([key, val]) => [key, Buffer.from(val).toString('base64')]),
        ),
      }),
    );
  } finally {
    client.destroy();
  }
}

main().catch(() => {
  // Error messages from JSON parsing or AWS must not print private material.
  console.error('Could not read the Azure Reader secret for the autoscaler');
  process.exitCode = 1;
});
