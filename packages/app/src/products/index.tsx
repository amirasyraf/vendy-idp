import {
  createFrontendPlugin,
  createRouteRef,
  PageBlueprint,
} from '@backstage/frontend-plugin-api';
import { EntityContentLayoutBlueprint } from '@backstage/plugin-catalog-react/alpha';
import { bucket, productOf, productPath, virtualMachines } from './catalog';

export const productsPlugin = createFrontendPlugin({
  pluginId: 'products',
  extensions: [
    PageBlueprint.make({
      name: 'virtual-machines',
      params: {
        path: productPath(virtualMachines),
        title: virtualMachines.title,
        noHeader: true,
        routeRef: createRouteRef(),
        loader: async () =>
          import('./VmProductPage').then(m => <m.VmProductPage />),
      },
    }),
    PageBlueprint.make({
      name: 'buckets',
      params: {
        path: productPath(bucket),
        title: bucket.title,
        noHeader: true,
        routeRef: createRouteRef(),
        loader: async () => import('../buckets/BucketList').then(m => <m.BucketList />),
      },
    }),
    PageBlueprint.make({
      name: 'bucket-files',
      params: {
        path: `${productPath(bucket)}/:bucketId`,
        noHeader: true,
        routeRef: createRouteRef(),
        loader: async () => import('../buckets/BucketPage').then(m => <m.BucketPage />),
      },
    }),
    EntityContentLayoutBlueprint.make({
      name: 'bucket',
      params: {
        filter: entity => productOf(entity) === bucket,
        loader: async () => (await import('../buckets/BucketList')).BucketOverview,
      },
    }),
  ],
});
