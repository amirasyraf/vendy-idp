import type { ReactNode } from 'react';
import { makeStyles, SvgIcon } from '@material-ui/core';
import Code from '@material-ui/icons/Code';
import DnsOutlined from '@material-ui/icons/DnsOutlined';
import LayersOutlined from '@material-ui/icons/LayersOutlined';
import Storage from '@material-ui/icons/Storage';
import FolderOpenOutlined from '@material-ui/icons/FolderOpenOutlined';

const useStyles = makeStyles({
  tile: {
    display: 'inline-grid',
    placeItems: 'center',
    width: 36,
    height: 36,
    borderRadius: 8,
    flex: '0 0 36px',
    '& svg': { width: 22, height: 22 },
    '& img': { width: 28, height: 'auto' },
  },
});

const icons: Record<string, [string, string, ReactNode]> = {
  compute: ['#0B5FD3', '#EAF2FF', <Storage />],
  'virtual-machines': ['#0B5FD3', '#EAF2FF', <DnsOutlined />],
  containers: ['#0B5FD3', '#EAF2FF', <LayersOutlined />],
  storage: ['#0B5FD3', '#EAF2FF', <Storage />],
  bucket: ['#0B5FD3', '#EAF2FF', <FolderOpenOutlined />],
  aws: ['#232F3E', '#FFF3E0', <img src="/aws-mark.svg" alt="" />],
  azure: [
    '#006EB6',
    '#EAF5FF',
    <SvgIcon><path d="M8 3h6L7 20H1zm7 3 8 14H10l3-4h4l-4-6z" /></SvgIcon>,
  ],
  vsphere: ['#535E6C', '#EEF0F3', <DnsOutlined />],
  ubuntu: [
    '#B93B13',
    '#FFF0E9',
    <SvgIcon>
      <circle cx="12" cy="12" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="3.5" r="2.7" />
      <circle cx="4.6" cy="16.2" r="2.7" />
      <circle cx="19.4" cy="16.2" r="2.7" />
    </SvgIcon>,
  ],
  windows: [
    '#006EB6',
    '#EAF5FF',
    <SvgIcon><path d="M3 3h8v8H3zm10 0h8v8h-8zM3 13h8v8H3zm10 0h8v8h-8z" /></SvgIcon>,
  ],
  linux: ['#3B5480', '#EEF2FA', <Code />],
};

export function LaunchIcon({ id, fallback }: { id: string; fallback?: string }) {
  const classes = useStyles();
  const icon =
    icons[id] ?? (fallback ? icons[fallback] : undefined) ?? icons.compute;
  const [color, background, glyph] = icon;
  return (
    <span className={classes.tile} style={{ color, background }} aria-hidden="true">
      {glyph}
    </span>
  );
}
