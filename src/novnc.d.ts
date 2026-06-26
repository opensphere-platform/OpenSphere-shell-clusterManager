// @novnc/novnc는 타입 선언을 배포하지 않음 → RFB 클래스를 any로 선언(esbuild는 ESM 소스를 번들).
declare module '@novnc/novnc/core/rfb' {
  const RFB: any;
  export default RFB;
}
