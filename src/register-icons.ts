import {
  applicationsIcon,
  ClarityIcons,
  clusterIcon,
  dashboardIcon,
  networkGlobeIcon,
  rackServerIcon,
  shieldIcon,
  storageIcon,
  twoWayArrowsIcon,
  vmIcon,
} from '@clr/angular';

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
