import {
  coreServices,
  createBackendModule,
} from '@backstage/backend-plugin-api';
import { catalogProcessingExtensionPoint } from '@backstage/plugin-catalog-node';

export const bucketCatalogModule = createBackendModule({
  pluginId: 'catalog',
  moduleId: 'vendy-buckets',
  register(reg) {
    reg.registerInit({
      deps: {
        processing: catalogProcessingExtensionPoint,
        auth: coreServices.auth,
        discovery: coreServices.discovery,
        scheduler: coreServices.scheduler,
      },
      async init({ processing, auth, discovery, scheduler }) {
        processing.addEntityProvider({
          getProviderName: () => 'vendy-buckets',
          async connect(connection) {
            await scheduler.scheduleTask({
              id: 'vendy-buckets',
              frequency: { seconds: 30 },
              timeout: { seconds: 20 },
              fn: async () => {
                const { token } = await auth.getPluginRequestToken({
                  onBehalfOf: await auth.getOwnServiceCredentials(),
                  targetPluginId: 'buckets',
                });
                const url = await discovery.getBaseUrl('buckets');
                const response = await fetch(`${url}/catalog`, {
                  headers: { Authorization: `Bearer ${token}` },
                  signal: AbortSignal.timeout(10_000),
                });
                if (!response.ok)
                  throw new Error(
                    `Cannot read Bucket catalog (HTTP ${response.status})`,
                  );
                const rows = (await response.json()) as {
                  id: string;
                  name: string;
                  team: string;
                  platform: string;
                }[];
                await connection.applyMutation({
                  type: 'full',
                  entities: rows.map(row => ({
                    locationKey: 'vendy-buckets',
                    entity: {
                      apiVersion: 'backstage.io/v1alpha1',
                      kind: 'Resource',
                      metadata: {
                        name: `bucket-${row.id}`,
                        title: row.name,
                        annotations: {
                          'backstage.io/managed-by-location': `vendy-buckets:${row.id}`,
                          'backstage.io/managed-by-origin-location': `vendy-buckets:${row.id}`,
                          'cf/bucket-id': row.id,
                          'cf/platform': row.platform,
                        },
                      },
                      spec: {
                        type: 'bucket',
                        owner: `group:default/${row.team}`,
                      },
                    },
                  })),
                });
              },
            });
          },
        });
      },
    });
  },
});
