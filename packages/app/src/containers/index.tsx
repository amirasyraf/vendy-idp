import { Entity } from '@backstage/catalog-model';
import {
  createFrontendPlugin,
  createRouteRef,
  PageBlueprint,
} from '@backstage/frontend-plugin-api';
import {
  EntityContentLayoutBlueprint,
  EntityHeaderLayoutBlueprint,
} from '@backstage/plugin-catalog-react/alpha';
import { containers, productPath } from '../products/catalog';

const isContainer = (entity: Entity) =>
  entity.kind.toLowerCase() === 'resource' && entity.spec?.type === 'container';

// Compute -> Containers: run pages, product page and catalog entity layout.
export const containersPlugin = createFrontendPlugin({
  pluginId: 'containers',
  extensions: [
    PageBlueprint.make({
      name: 'runs',
      params: {
        path: '/containers',
        noHeader: true,
        routeRef: createRouteRef(),
        loader: async () => import('./ContainerRunPage').then(m => <m.ContainerRunsPage />),
      },
    }),
    PageBlueprint.make({
      name: 'product',
      params: {
        path: productPath(containers),
        title: containers.title,
        noHeader: true,
        routeRef: createRouteRef(),
        loader: async () => import('./ContainersProductPage').then(m => <m.ContainersProductPage />),
      },
    }),
    EntityHeaderLayoutBlueprint.make({
      name: 'container',
      params: {
        filter: isContainer,
        loader: async () => (await import('./ContainerCard')).ContainerHeaderLayout,
      },
    }),
    EntityContentLayoutBlueprint.make({
      name: 'container',
      params: {
        filter: isContainer,
        loader: async () => (await import('./ContainerCard')).ContainerOverview,
      },
    }),
  ],
});
