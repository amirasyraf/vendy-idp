import {
  coreServices,
  createBackendModule,
} from '@backstage/backend-plugin-api';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import { policyExtensionPoint } from '@backstage/plugin-permission-node/alpha';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { ComputeFactoryPolicy } from './policy';
import { createSshSignAction } from './sign';
import { authProvidersExtensionPoint } from '@backstage/plugin-auth-node';
import { passwordProviderFactory } from './auth';
import {
  createBucketAction,
  createContainerDispatchAction,
  createVmDispatchAction,
  createVmRunAction,
} from './actions';

export { mockRestPlugin } from './servicenow';
export { vmsPlugin } from './vms';
export { containersPlugin } from './containers';
export { clientLogPlugin } from './clientLog';
export { vmSizesPlugin } from './vmSizes';
export { bucketsPlugin } from './buckets';
export { bucketCatalogModule } from './bucketCatalog';

export const passwordAuthModule = createBackendModule({
  pluginId: 'auth',
  moduleId: 'compute-factory-password',
  register(reg) {
    reg.registerInit({
      deps: { providers: authProvidersExtensionPoint },
      async init({ providers }) {
        providers.registerProvider({
          providerId: 'password',
          factory: passwordProviderFactory,
        });
      },
    });
  },
});

// One package; Backstage requires a registration for each owning plugin.
export const permissionModule = createBackendModule({
  pluginId: 'permission',
  moduleId: 'compute-factory',
  register(reg) {
    reg.registerInit({
      deps: { policy: policyExtensionPoint, userInfo: coreServices.userInfo },
      async init({ policy, userInfo }) {
        policy.setPolicy(new ComputeFactoryPolicy(userInfo));
      },
    });
  },
});
export const sshModule = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'compute-factory',
  register(reg) {
    reg.registerInit({
      deps: {
        actions: scaffolderActionsExtensionPoint,
        catalog: catalogServiceRef,
        auth: coreServices.auth,
        discovery: coreServices.discovery,
      },
      async init({ actions, catalog, auth, discovery }) {
        actions.addActions(
          createSshSignAction(catalog, auth),
          createVmDispatchAction(auth, discovery),
          createVmRunAction(auth, discovery),
          createContainerDispatchAction(auth, discovery),
          createBucketAction(auth, discovery),
        );
      },
    });
  },
});
