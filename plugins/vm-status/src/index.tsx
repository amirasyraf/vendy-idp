import { Entity } from '@backstage/catalog-model';
import {
  createFrontendPlugin,
  createRouteRef,
  PageBlueprint,
} from '@backstage/frontend-plugin-api';
import {
  EntityCardBlueprint,
  EntityContentLayoutBlueprint,
  EntityHeaderLayoutBlueprint,
} from '@backstage/plugin-catalog-react/alpha';

export {
  PipelineLine,
  STATIONS,
  activeStation,
  runProcesses,
  runStations,
  vmColors,
  vmState,
  vmStateColor,
  vmStateLabel,
  vmRunLabel,
  observedLabel,
  runNoun,
  stageLabel,
  VmActivityTime,
  type VmState,
} from './pipeline';
export {
  useRunSummary,
  useVmsApi,
  runVmStatus,
  type ObservedVm,
  type RunView,
  type StageView,
} from './runs';
export { getVmConfiguration } from './vmSpec';
export { ComputeDetailColumns, ComputeEntityHeader } from './VmPage';
export {
  describeSpecs,
  memoryText,
  osFamily,
  osLabel,
  platformLabel,
  sizeBadge,
  useSoftwareCatalog,
  useDemoRestriction,
  useInstanceTypeCatalog,
  usePlatforms,
  useImageAvailability,
  useVmSizeText,
  useVmSizes,
  type CatalogInstanceType,
  type DemoRestriction,
  type InstanceSpecs,
  type InstanceTypeCatalog,
  type PlatformInfo,
  type SoftwareItem,
  type VmSize,
  type VmSizes,
} from './vmSizes';

const isVm = (entity: Entity) =>
  entity.kind.toLowerCase() === 'resource' && entity.spec?.type === 'vm';

export default createFrontendPlugin({
  pluginId: 'vm-status',
  extensions: [
    PageBlueprint.make({
      name: 'runs',
      params: {
        path: '/vms',
        noHeader: true,
        routeRef: createRouteRef(),
        loader: async () => import('./RunView').then(m => <m.VmRunsPage />),
      },
    }),
    EntityCardBlueprint.make({
      name: 'status',
      params: {
        filter: isVm,
        loader: async () =>
          import('./VmStatusCard').then(m => <m.VmStatusCard />),
      },
    }),
    EntityHeaderLayoutBlueprint.make({
      name: 'vm',
      params: {
        filter: isVm,
        loader: async () => (await import('./VmPage')).VmHeaderLayout,
      },
    }),
    EntityContentLayoutBlueprint.make({
      name: 'vm',
      params: {
        filter: isVm,
        loader: async () => (await import('./VmPage')).VmContentLayout,
      },
    }),
  ],
});
