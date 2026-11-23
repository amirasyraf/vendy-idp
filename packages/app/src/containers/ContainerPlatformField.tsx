import { Link } from '@backstage/core-components';
import type { FieldExtensionComponentProps } from '@backstage/plugin-scaffolder-react';
import { createFormField } from '@backstage/plugin-scaffolder-react/alpha';
import { Box, FormHelperText, Paper } from '@material-ui/core';
import { containerPlatforms, containers, launchPath } from '../products/catalog';

function ContainerPlatformField({
  formData,
  rawErrors,
}: FieldExtensionComponentProps<string>) {
  const platform = containerPlatforms.find(item => item.id === formData);
  return (
    <Box my={2}>
      <Paper variant="outlined">
        <Box
          display="flex"
          alignItems="center"
          justifyContent="space-between"
          p={2}
        >
          <div>
            <small>Platform</small>
            <br />
            <b>{platform?.label ?? 'No platform selected'}</b>
          </div>
          <Link to={launchPath(containers)}>
            {platform ? 'Change Platform' : 'Choose a Platform'}
          </Link>
        </Box>
      </Paper>
      {rawErrors?.length ? (
        <FormHelperText error>{rawErrors.join(', ')}</FormHelperText>
      ) : null}
    </Box>
  );
}

export const ContainerPlatform = createFormField({
  name: 'ContainerPlatform',
  component: ContainerPlatformField,
});
