import { useState } from 'react';
import {
  Box,
  Button,
  FormHelperText,
  IconButton,
  TextField,
  Typography,
  makeStyles,
} from '@material-ui/core';
import AddIcon from '@material-ui/icons/Add';
import DeleteOutline from '@material-ui/icons/DeleteOutline';
import type { FieldExtensionComponentProps } from '@backstage/plugin-scaffolder-react';
import { createFormField } from '@backstage/plugin-scaffolder-react/alpha';
import { PlatformInfo, usePlatforms } from '@internal/plugin-vm-status';

type Tags = {
  costCenter?: string;
  projectCode?: string;
  extra?: Record<string, string>;
};
type Row = { key: string; value: string };

const maxExtra = 40;
// The platform derives these tag keys from billing; users cannot set them as extra tags.
const fixed = [
  { field: 'costCenter', key: 'cost_center' },
  { field: 'projectCode', key: 'project_code' },
] as const;
// Every platform's platform.json reservedTagPrefixes/forbiddenTagKeyCharacters, for submit-time
// validation, which cannot load them; the row errors below use the chosen platform's own rules.
// The platform repo's spec.py is the authoritative check.
const anyPlatform = {
  reservedTagPrefixes: ['aws:', 'azure', 'microsoft', 'windows'],
  forbiddenTagKeyCharacters: '<>%&\\?/',
};
type TagRules = Pick<
  PlatformInfo,
  'reservedTagPrefixes' | 'forbiddenTagKeyCharacters'
>;

/** Why a tag key cannot be used on the platform, or undefined. */
export function tagKeyProblem(
  key: string,
  rules: TagRules = anyPlatform,
): string | undefined {
  const lower = key.toLowerCase();
  if (
    lower === 'name' ||
    fixed.some(item => item.key === lower) ||
    ['cf:', 'billing:', ...rules.reservedTagPrefixes].some(prefix =>
      lower.startsWith(prefix),
    )
  )
    return 'Reserved key';
  const bad = [...rules.forbiddenTagKeyCharacters].find(char =>
    key.includes(char),
  );
  return bad ? `"${bad}" is not allowed in keys` : undefined;
}

function rowError(
  row: Row,
  rows: Row[],
  rules: TagRules | undefined,
): string | undefined {
  const key = row.key.trim();
  if (!key) return row.value ? 'Key is required' : undefined;
  if (key.length > 128) return 'Key is longer than 128 characters';
  const problem = tagKeyProblem(key, rules);
  if (problem) return problem;
  if (rows.filter(item => item.key.trim() === key).length > 1)
    return 'Duplicate key';
  if (row.value.length > 256) return 'Value is longer than 256 characters';
  return undefined;
}

const useStyles = makeStyles(theme => ({
  grid: {
    display: 'grid',
    gridTemplateColumns: 'minmax(160px, 1fr) minmax(200px, 2fr) 40px',
    gap: theme.spacing(1),
    alignItems: 'start',
    '@media (max-width: 600px)': {
      gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.3fr) 32px',
    },
  },
  head: {
    fontSize: 12,
    fontWeight: 600,
    color: theme.palette.text.secondary,
  },
  fixedKey: { '& input': { fontFamily: '"JetBrains Mono", monospace' } },
}));

/**
 * `ui:field: VmTagsEditor` on the vm-request template's `tags` object: one cloud tags table,
 * checked against the platform chosen in the form's `compute`.
 * `cost_center` and `project_code` are fixed keys with mandatory values; more tags are optional.
 */
function VmTagsEditorField({
  onChange,
  formData,
  schema,
  rawErrors,
  disabled,
  formContext,
}: FieldExtensionComponentProps<Tags>) {
  const classes = useStyles();
  const value: Tags = formData ?? {};
  const platform = (
    formContext?.formData as { compute?: { platform?: string } } | undefined
  )?.compute?.platform;
  const rules = usePlatforms()?.find(item => item.id === platform);
  const [rows, setRows] = useState<Row[]>(() =>
    Object.entries(value.extra ?? {}).map(([key, item]) => ({
      key,
      value: item,
    })),
  );
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  const emitRows = (next: Row[]) => {
    setRows(next);
    const extra: Record<string, string> = {};
    for (const row of next)
      if (row.key.trim()) extra[row.key.trim()] = row.value;
    onChange({ ...value, extra });
  };

  return (
    <Box my={2}>
      <Typography variant="subtitle1">
        <b>{schema.title ?? 'Tags'}</b>
      </Typography>
      {schema.description && (
        <Typography variant="body2" color="textSecondary">
          {schema.description}
        </Typography>
      )}
      <Box
        className={classes.grid}
        mt={1.5}
        role="table"
        aria-label="Cloud tags"
      >
        <span className={classes.head}>Key</span>
        <span className={classes.head}>Value</span>
        <span />
        {fixed.map(item => {
          const current = value[item.field] ?? '';
          const missing = touched[item.field] && !current.trim();
          return [
            <TextField
              key={`${item.key}-key`}
              size="small"
              variant="outlined"
              value={item.key}
              disabled
              className={classes.fixedKey}
              inputProps={{ 'aria-label': `${item.key} key` }}
            />,
            <TextField
              key={`${item.key}-value`}
              size="small"
              variant="outlined"
              required
              placeholder="Required"
              value={current}
              disabled={disabled}
              error={missing}
              helperText={missing ? 'Required' : undefined}
              inputProps={{ 'aria-label': `${item.key} value`, maxLength: 256 }}
              onBlur={() =>
                setTouched(state => ({ ...state, [item.field]: true }))
              }
              onChange={event =>
                onChange({ ...value, [item.field]: event.target.value })
              }
            />,
            <span key={`${item.key}-pad`} />,
          ];
        })}
        {rows.map((row, index) => {
          const error = rowError(row, rows, rules);
          return [
            <TextField
              key={`row-${index}-key`}
              size="small"
              variant="outlined"
              placeholder="Key"
              value={row.key}
              disabled={disabled}
              error={!!error}
              helperText={error}
              inputProps={{
                'aria-label': `Tag ${index + 1} key`,
                maxLength: 128,
              }}
              onChange={event =>
                emitRows(
                  rows.map((item, i) =>
                    i === index ? { ...item, key: event.target.value } : item,
                  ),
                )
              }
            />,
            <TextField
              key={`row-${index}-value`}
              size="small"
              variant="outlined"
              placeholder="Value"
              value={row.value}
              disabled={disabled}
              inputProps={{
                'aria-label': `Tag ${index + 1} value`,
                maxLength: 256,
              }}
              onChange={event =>
                emitRows(
                  rows.map((item, i) =>
                    i === index ? { ...item, value: event.target.value } : item,
                  ),
                )
              }
            />,
            <IconButton
              key={`row-${index}-remove`}
              size="small"
              aria-label={`Remove tag ${index + 1}`}
              disabled={disabled}
              onClick={() => emitRows(rows.filter((_, i) => i !== index))}
            >
              <DeleteOutline fontSize="small" />
            </IconButton>,
          ];
        })}
      </Box>
      <Button
        size="small"
        startIcon={<AddIcon />}
        disabled={disabled || rows.length >= maxExtra}
        onClick={() => setRows([...rows, { key: '', value: '' }])}
        style={{ marginTop: 8, textTransform: 'none' }}
      >
        Add tag
      </Button>
      {!!rawErrors?.length && (
        <FormHelperText error>{rawErrors.join(', ')}</FormHelperText>
      )}
    </Box>
  );
}

export const VmTagsEditor = createFormField({
  name: 'VmTagsEditor',
  component: VmTagsEditorField,
  validation: (data: Tags, field) => {
    if (!data?.costCenter?.trim()) field.addError('cost_center is required');
    if (!data?.projectCode?.trim()) field.addError('project_code is required');
    const keys = Object.keys(data?.extra ?? {});
    if (keys.length > maxExtra)
      field.addError(`At most ${maxExtra} extra tags`);
    for (const key of keys) {
      const problem = tagKeyProblem(key);
      if (problem) field.addError(`Tag key "${key}": ${problem}`);
      else if (key.length > 128) field.addError(`Tag key "${key}" is too long`);
    }
  },
});
