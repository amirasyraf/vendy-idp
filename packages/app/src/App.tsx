import { createApp } from '@backstage/frontend-defaults';
import {
  AppRootElementBlueprint,
  coreExtensionData,
  createFrontendModule,
  discoveryApiRef,
  fetchApiRef,
  identityApiRef,
} from '@backstage/frontend-plugin-api';
import { scmIntegrationsApiRef } from '@backstage/integration-react';
import scaffolderPlugin from '@backstage/plugin-scaffolder/alpha';
import { scaffolderApiRef } from '@backstage/plugin-scaffolder-react';
import { FormFieldBlueprint } from '@backstage/plugin-scaffolder-react/alpha';
import { PollingScaffolderClient } from './taskEventPolling';
import { VmTaskRedirect } from './VmTaskRedirect';
import { LaunchFormLayout } from './launch/LaunchFormLayout';
import { SignInPageBlueprint } from '@backstage/plugin-app-react';
import { PasswordSignInPage } from './PasswordSignInPage';
import vmStatus from '@internal/plugin-vm-status';
import catalogPlugin from '@backstage/plugin-catalog/alpha';
import { navModule } from './modules/nav';
import { homeModule } from './modules/home';
import { launchPlugin } from './launch';
import { productsPlugin } from './products';
import { containersPlugin } from './containers';
import { CatalogKindFilter } from './CatalogKindFilter';
import { CatalogPage } from './CatalogPage';
import { cfLightTheme } from './theme/cfTheme';
import userSettingsPlugin from '@backstage/plugin-user-settings/alpha';
import { SettingsGeneral } from './SettingsGeneral';
import { ClientMonitor } from './ClientMonitor';

const signInPage = SignInPageBlueprint.make({
  params: {
    loader: async () => props => <PasswordSignInPage {...props} />,
  },
});

// New-version banner and browser error reporting (see ClientMonitor.tsx).
const clientMonitor = AppRootElementBlueprint.make({
  name: 'client-monitor',
  params: { element: <ClientMonitor /> },
});

// Scaffolder customisations; default fields, task UI, logs and controls are preserved.
const scaffolder = scaffolderPlugin.withOverrides({
  extensions: [
    scaffolderPlugin.getExtension('sub-page:scaffolder/templates').override({
      factory(originalFactory) {
        const original = originalFactory();
        return Array.from(original, output =>
          output.id === coreExtensionData.reactElement.id
            ? coreExtensionData.reactElement(
                <LaunchFormLayout>
                  {original.get(coreExtensionData.reactElement)}
                </LaunchFormLayout>,
              )
            : output,
        );
      },
    }),
    FormFieldBlueprint.make({
      name: 'container-platform',
      params: {
        field: () =>
          import('./containers/ContainerPlatformField').then(
            m => m.ContainerPlatform,
          ),
      },
    }),
    // VM request compute field: the chosen platform/image, size cards with live specs and an
    // Advanced instance-type picker (platform template `ui:field: VmComputePicker`).
    FormFieldBlueprint.make({
      name: 'vm-compute-picker',
      params: {
        field: () => import('./VmComputePicker').then(m => m.VmComputePicker),
      },
    }),
    // Software checkboxes from the platform repo's catalog, for the chosen OS's family.
    FormFieldBlueprint.make({
      name: 'vm-software-picker',
      params: {
        field: () => import('./VmSoftwarePicker').then(m => m.VmSoftwarePicker),
      },
    }),
    // One cloud tags table: fixed cost_center/project_code plus optional tags.
    FormFieldBlueprint.make({
      name: 'vm-tags-editor',
      params: {
        field: () => import('./VmTagsEditor').then(m => m.VmTagsEditor),
      },
    }),
    // Older template revision used `ui:field: VmSizePicker` on `size`; cards only.
    FormFieldBlueprint.make({
      name: 'vm-size-picker',
      params: {
        field: () => import('./VmComputePicker').then(m => m.VmSizePicker),
      },
    }),
    // Long-poll task events instead of SSE (see taskEventPolling.ts, incl. how to revert).
    scaffolderPlugin.getExtension('api:scaffolder').override({
      params: defineParams =>
        defineParams({
          api: scaffolderApiRef,
          deps: {
            discoveryApi: discoveryApiRef,
            scmIntegrationsApi: scmIntegrationsApiRef,
            fetchApi: fetchApiRef,
            identityApi: identityApiRef,
          },
          factory: deps => new PollingScaffolderClient(deps),
        }),
    }),
    scaffolderPlugin.getExtension('sub-page:scaffolder/tasks').override({
      factory(originalFactory) {
        const original = originalFactory();
        return Array.from(original, output =>
          output.id === coreExtensionData.reactElement.id
            ? coreExtensionData.reactElement(
                <VmTaskRedirect>
                  {original.get(coreExtensionData.reactElement)}
                </VmTaskRedirect>,
              )
            : output,
        );
      },
    }),
  ],
});

const catalog = catalogPlugin.withOverrides({
  extensions: [
    catalogPlugin.getExtension('catalog-filter:catalog/kind').override({
      params: { loader: async () => <CatalogKindFilter /> },
    }),
    // Own page shell and VM columns; filters still come from the extension inputs.
    catalogPlugin.getExtension('page:catalog').override({
      factory(originalFactory, { inputs, config }) {
        const filters = inputs.filters.map(filter =>
          filter.get(coreExtensionData.reactElement),
        );
        return originalFactory({
          params: {
            noHeader: true,
            loader: async () => (
              <CatalogPage
                filters={<>{filters}</>}
                pagination={config.pagination}
              />
            ),
          },
        });
      },
    }),
    // Entity pages draw their own headers; drop the plugin "Catalog" bar.
    catalogPlugin.getExtension('page:catalog/entity').override({
      params: { noHeader: true },
    }),
  ],
});
const userSettings = userSettingsPlugin.withOverrides({
  extensions: [
    userSettingsPlugin.getExtension('sub-page:user-settings/general').override({
      params: { loader: async () => <SettingsGeneral /> },
    }),
  ],
});

export default createApp({
  features: [
    catalog,
    userSettings,
    scaffolder,
    vmStatus,
    launchPlugin,
    productsPlugin,
    containersPlugin,
    navModule,
    homeModule,
    createFrontendModule({
      pluginId: 'app',
      extensions: [signInPage, cfLightTheme, clientMonitor],
    }),
  ],
});
