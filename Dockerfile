# Perspective 2 K8s Cluster + Ceph — 구 k8s-console-ng 피처 컨테이너 흡수(누락 없이).
#   perspective ui-shell(서명본) → /app/plugins, Angular 범용 K8s 콘솔(dist) → /app/www, 제네릭 프록시 + WS exec.
FROM node:22-alpine
WORKDIR /app
COPY package.json /app/package.json
RUN npm install --omit=dev --no-audit --no-fund
COPY --chmod=0644 server.js /app/server.js
COPY ui-shell/ /app/plugins/
COPY www /app/www
# Kanidm(콘솔 IdP) self-signed CA — 쓰기/exec 시 ES256 토큰 in-cluster JWKS(svc:8443) TLS 신뢰용(명시적 ca 옵션).
COPY kanidm-ca.crt /etc/kanidm-ca/ca.crt
ENV PLUGINS_DIR=/app/plugins WWW_DIR=/app/www PORT=8080 \
    NODE_EXTRA_CA_CERTS=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt \
    KANIDM_CA_PATH=/etc/kanidm-ca/ca.crt
EXPOSE 8080
USER 1000
CMD ["node", "/app/server.js"]
