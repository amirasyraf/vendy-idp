import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography,
} from '@material-ui/core';
import { useState } from 'react';
import { Bucket, Credentials, describeError, useBucketRequest } from './api';

export function CredentialsDialog({
  bucket,
  close,
}: {
  bucket: Bucket;
  close: () => void;
}) {
  const request = useBucketRequest();
  const [minutes, setMinutes] = useState('60');
  const [credential, setCredential] = useState<Credentials>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const duration = Number(minutes);
  const valid = Number.isInteger(duration) && duration >= 15 && duration <= 480;

  async function generate(event: React.FormEvent) {
    event.preventDefault();
    if (!valid || busy || credential) return;
    setBusy(true);
    setError('');
    try {
      setCredential(
        await request<Credentials>(`/${bucket.id}/credentials`, {
          minutes: duration,
        }),
      );
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  }

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setMessage(`${label} copied.`);
    } catch {
      setError('Could not copy. Select the value and copy it manually.');
    }
  }
  const secret = (label: string, value: string) => (
    <Box display="flex" alignItems="center" gridGap={8} mt={2}>
      <TextField
        fullWidth
        variant="outlined"
        size="small"
        label={label}
        value={value}
        InputProps={{ readOnly: true }}
      />
      <Button
        onClick={() => void copy(value, label)}
        aria-label={`Copy ${label}`}
      >
        Copy
      </Button>
    </Box>
  );
  const awsCommands =
    credential?.platform === 'aws'
      ? [
          'read -rs AWS_ACCESS_KEY_ID; export AWS_ACCESS_KEY_ID',
          'read -rs AWS_SECRET_ACCESS_KEY; export AWS_SECRET_ACCESS_KEY',
          'read -rs AWS_SESSION_TOKEN; export AWS_SESSION_TOKEN',
          `aws s3 cp ./file "s3://${credential.bucket}/file" --region ${credential.region}`,
          'unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN',
        ]
      : [];
  const azureCommands =
    credential?.platform === 'azure'
      ? [
          'read -rs BUCKET_SAS',
          `azcopy copy ./file "${credential.url}/file?\${BUCKET_SAS}" --from-to=LocalBlob --overwrite=true`,
          'unset BUCKET_SAS',
        ]
      : [];

  return (
    <Dialog
      open
      fullWidth
      maxWidth="sm"
      onClose={close}
      aria-labelledby="bucket-credentials-title"
    >
      <form onSubmit={event => void generate(event)}>
        <DialogTitle id="bucket-credentials-title">
          CLI upload credentials
        </DialogTitle>
        <DialogContent>
          <Typography gutterBottom>
            These credentials can upload to <strong>{bucket.name}</strong>,
            including overwriting existing files. They cannot read file contents
            or delete files.
          </Typography>
          {!credential && (
            <TextField
              label="Expires after (minutes)"
              id="bucket-credential-expiry"
              type="number"
              value={minutes}
              onChange={event => setMinutes(event.target.value)}
              inputProps={{ min: 15, max: 480 }}
              helperText="Choose 15–480 minutes (8 hours)."
              margin="normal"
            />
          )}
          {credential && (
            <>
              <Typography gutterBottom>
                Expires {new Date(credential.expiresAt).toLocaleString()}. Copy
                the credentials before closing.
              </Typography>
              {credential.platform === 'aws' ? (
                <>
                  {secret('Access key ID', credential.accessKeyId)}
                  {secret('Secret access key', credential.secretAccessKey)}
                  {secret('Session token', credential.sessionToken)}
                  <Box mt={2}>
                    <Typography variant="subtitle2">AWS CLI v2</Typography>
                  </Box>
                </>
              ) : (
                <>
                  {secret('SAS token', credential.sas)}
                  <Box mt={2}>
                    <Typography variant="subtitle2">AzCopy v10</Typography>
                  </Box>
                </>
              )}
              <Typography variant="body2">
                Run one line at a time in Bash. Paste the requested value after
                each <code>read</code> and press Enter.
              </Typography>
              <Box
                component="pre"
                overflow="auto"
                bgcolor="action.hover"
                p={1.5}
              >
                {[...awsCommands, ...azureCommands].join('\n')}
              </Box>
            </>
          )}
          {message && <Typography role="status">{message}</Typography>}
          {error && (
            <Typography role="alert" color="error">
              {error}
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={close}>Close</Button>
          {!credential && (
            <Button
              type="submit"
              disabled={!valid || busy}
              variant="contained"
              color="primary"
            >
              {busy ? 'Generating…' : 'Generate'}
            </Button>
          )}
        </DialogActions>
      </form>
    </Dialog>
  );
}
