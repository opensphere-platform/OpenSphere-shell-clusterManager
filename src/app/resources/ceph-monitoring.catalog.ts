export type CephDashboardCategory =
  | 'cluster'
  | 'storage'
  | 'hosts'
  | 'block'
  | 'gateways';

export interface CephDashboard {
  uid: string;
  slug: string;
  label: string;
  title: string;
  description: string;
  category: CephDashboardCategory;
}

export interface CephDashboardGroup {
  id: CephDashboardCategory;
  label: string;
  description: string;
}

/**
 * Ceph가 게시한 Grafana dashboard catalog의 검증된 allowlist.
 *
 * 브라우저 입력이나 API 응답을 iframe URL로 직접 사용하지 않는다. 새 dashboard는 Ceph
 * Grafana의 /api/search 결과를 확인한 뒤 이 목록에 명시적으로 등록해야 한다.
 */
export const CEPH_GRAFANA_ORIGIN = 'https://ceph.triangles.com';
export const CEPH_GRAFANA_BASE_PATH = '/grafana';

export const CEPH_DASHBOARD_GROUPS: readonly CephDashboardGroup[] = [
  { id: 'cluster', label: '클러스터', description: '전체 상태와 서비스 개요' },
  { id: 'storage', label: 'Pool · CephFS · OSD', description: '용량, PG, 파일시스템과 장치 상태' },
  { id: 'hosts', label: '호스트', description: 'Ceph 호스트와 배포 단위' },
  { id: 'block', label: 'RBD 블록 스토리지', description: 'Kubernetes PVC가 사용하는 RBD 경로' },
  { id: 'gateways', label: '게이트웨이 · 파일 서비스', description: 'RGW, NVMe-oF, SMB 서비스' },
] as const;

export const CEPH_DASHBOARDS: readonly CephDashboard[] = [
  {
    uid: 'edtb0oxdq',
    slug: 'ceph-cluster',
    label: '클러스터',
    title: 'Ceph - Cluster',
    description: 'Ceph health, 용량, PG와 주요 daemon 상태를 한 화면에서 확인합니다.',
    category: 'cluster',
  },
  {
    uid: '92LBIaJIz2',
    slug: 'ceph-application-overview',
    label: '애플리케이션 개요',
    title: 'Ceph - Application Overview',
    description: 'Ceph 서비스를 사용하는 애플리케이션 관점의 부하와 사용량입니다.',
    category: 'cluster',
  },
  {
    uid: 'BnxelG7Sx',
    slug: 'ceph-multi-cluster',
    label: '멀티 클러스터',
    title: 'Ceph - Multi-cluster',
    description: 'Grafana datasource에 등록된 Ceph 클러스터를 비교합니다.',
    category: 'cluster',
  },
  {
    uid: 'dn13KBeTv',
    slug: 'ceph-cluster-advanced',
    label: '클러스터 상세',
    title: 'Ceph Cluster - Advanced',
    description: '운영 진단에 필요한 고급 cluster 지표를 표시합니다.',
    category: 'cluster',
  },
  {
    uid: 'z99hzWtmk',
    slug: 'ceph-pools-overview',
    label: 'Pool 개요',
    title: 'Ceph Pools Overview',
    description: '전체 pool의 용량, 객체와 I/O 분포를 비교합니다.',
    category: 'storage',
  },
  {
    uid: '-xyV8KCiz',
    slug: 'ceph-pool-details',
    label: 'Pool 상세',
    title: 'Ceph Pool Details',
    description: '선택한 pool의 사용량과 성능을 상세히 확인합니다.',
    category: 'storage',
  },
  {
    uid: '718Bruins',
    slug: 'ceph-filesystem-overview',
    label: 'CephFS 개요',
    title: 'Ceph - Filesystem Overview',
    description: 'CephFS filesystem과 MDS 상태, 클라이언트 활동을 확인합니다.',
    category: 'storage',
  },
  {
    uid: 'tbO9LAiZz',
    slug: 'mds-performance',
    label: 'MDS 성능',
    title: 'MDS Performance',
    description: 'CephFS metadata server의 요청과 지연 시간을 확인합니다.',
    category: 'storage',
  },
  {
    uid: 'lo02I1Aiz',
    slug: 'osd-overview',
    label: 'OSD 개요',
    title: 'OSD Overview',
    description: 'OSD 가용성, 사용률과 처리량을 비교합니다.',
    category: 'storage',
  },
  {
    uid: 'CrAHE0iZz',
    slug: 'osd-device-details',
    label: 'OSD 장치 상세',
    title: 'OSD device details',
    description: '선택한 OSD 장치의 I/O와 지연 지표를 상세히 확인합니다.',
    category: 'storage',
  },
  {
    uid: 'y0KGL0iZz',
    slug: 'host-overview',
    label: '호스트 개요',
    title: 'Host Overview',
    description: 'Ceph 호스트의 CPU, 메모리, 네트워크와 daemon 분포를 확인합니다.',
    category: 'hosts',
  },
  {
    uid: 'rtOg0AiWz',
    slug: 'host-details',
    label: '호스트 상세',
    title: 'Host Details',
    description: '선택한 Ceph 호스트의 자원 및 장치 지표를 상세히 확인합니다.',
    category: 'hosts',
  },
  {
    uid: '41FrpeUiz',
    slug: 'rbd-overview',
    label: 'RBD 개요',
    title: 'RBD Overview',
    description: 'Kubernetes 블록 PVC를 포함한 RBD image 사용량과 성능입니다.',
    category: 'block',
  },
  {
    uid: 'YhCYGcuZz',
    slug: 'rbd-details',
    label: 'RBD 상세',
    title: 'RBD Details',
    description: '선택한 RBD image의 I/O와 지연 시간을 상세히 확인합니다.',
    category: 'block',
  },
  {
    uid: 'WAkugZpiz',
    slug: 'rgw-overview',
    label: 'RGW 개요',
    title: 'RGW Overview',
    description: 'Ceph Object Gateway의 요청, 처리량과 오류 상태를 확인합니다.',
    category: 'gateways',
  },
  {
    uid: 'x5ARzZtmk',
    slug: 'rgw-instance-detail',
    label: 'RGW 인스턴스 상세',
    title: 'RGW Instance Detail',
    description: '선택한 RGW 인스턴스의 상세 성능 지표입니다.',
    category: 'gateways',
  },
  {
    uid: 'BnxelG7Sz',
    slug: 'rgw-s3-analytics',
    label: 'RGW S3 분석',
    title: 'RGW S3 Analytics',
    description: 'S3 API 사용 패턴과 응답 상태를 분석합니다.',
    category: 'gateways',
  },
  {
    uid: 'rgw-sync-overview',
    slug: 'rgw-sync-overview',
    label: 'RGW 동기화',
    title: 'RGW Sync Overview',
    description: 'RGW multisite 동기화 상태와 지연을 확인합니다.',
    category: 'gateways',
  },
  {
    uid: 'feeuv1dno43r4ddjhjssdd',
    slug: 'ceph-nvme-o-f-gateways-overview',
    label: 'NVMe-oF 개요',
    title: 'Ceph NVMe-oF Gateways - Overview',
    description: 'NVMe-oF gateway와 subsystem의 가용 상태를 확인합니다.',
    category: 'gateways',
  },
  {
    uid: 'feeuv1dno43r4deed',
    slug: 'ceph-nvme-o-f-gateways-performance',
    label: 'NVMe-oF 성능',
    title: 'Ceph NVMe-oF Gateways - Performance',
    description: 'NVMe-oF gateway의 처리량과 지연 지표를 확인합니다.',
    category: 'gateways',
  },
  {
    uid: 'feem6ehrmi2o0b',
    slug: 'smb-overview',
    label: 'SMB 개요',
    title: 'SMB Overview',
    description: 'Ceph SMB 서비스의 gateway와 client 상태를 확인합니다.',
    category: 'gateways',
  },
] as const;

