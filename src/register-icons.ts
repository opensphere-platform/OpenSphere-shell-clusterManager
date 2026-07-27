import '@cds/core/icon/register.js';
import { ClarityIcons } from '@cds/core/icon/icon.service.js';
import { applicationsIcon } from '@cds/core/icon/shapes/applications.js';
import { clusterIcon } from '@cds/core/icon/shapes/cluster.js';
import { dashboardIcon } from '@cds/core/icon/shapes/dashboard.js';
import { networkGlobeIcon } from '@cds/core/icon/shapes/network-globe.js';
import { rackServerIcon } from '@cds/core/icon/shapes/rack-server.js';
import { shieldIcon } from '@cds/core/icon/shapes/shield.js';
import { storageIcon } from '@cds/core/icon/shapes/storage.js';
import { twoWayArrowsIcon } from '@cds/core/icon/shapes/two-way-arrows.js';
import { vmIcon } from '@cds/core/icon/shapes/vm.js';

/** nav-icons.ts의 shape와 함께 변경해야 하는 런타임 등록 목록. */
export const REGISTERED_NAV_ICON_NAMES = [
  'applications',
  'cluster',
  'dashboard',
  'network-globe',
  'rack-server',
  'shield',
  'storage',
  'two-way-arrows',
  'vm',
] as const;

export function registerClusterManagerIcons(): void {
  ClarityIcons.addIcons(
    applicationsIcon,
    clusterIcon,
    dashboardIcon,
    networkGlobeIcon,
    rackServerIcon,
    shieldIcon,
    storageIcon,
    twoWayArrowsIcon,
    vmIcon,
  );
}
