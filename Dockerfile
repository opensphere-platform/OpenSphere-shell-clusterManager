# OpenSphere subShell: cluster-manager — standalone build.
#   Stage 1: build the Angular 22 app (Angular Element <osp-k8s-console-ng>) → dist/k8s-console-angular/browser
#            (angular.json: @angular/build:application, outputHashing=none → predictable main.js + styles.css)
#   Stage 2: runtime feature-container — server.js serves the built bundle at /app/www + signed ui-shell at
#            /app/plugins + generic /api/k8s/* proxy + WS exec. ws is the only runtime dep (rest are node built-ins).
FROM docker.io/library/node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --no-audit --no-fund
COPY angular.json tsconfig.json tsconfig.app.json ./
COPY src ./src
RUN npx ng build --configuration production

# HIS Helm executor and the closed, checksum-pinned chart catalog. Runtime
# installation does not accept arbitrary repositories and does not depend on
# a chart repository being reachable.
FROM docker.io/alpine/helm:3.19.0@sha256:aef9b56f64e866207d9591d0abd8f6d767b36aadd12edf68f8a719716d9d29c9 AS helm-assets
USER root
RUN mkdir -p /his-charts /ceph-charts \
    && helm pull ingress-nginx --repo https://kubernetes.github.io/ingress-nginx --version 4.15.1 --destination /his-charts \
    && helm pull metrics-server --repo https://kubernetes-sigs.github.io/metrics-server --version 3.13.1 --destination /his-charts \
    && helm pull oci://quay.io/jetstack/charts/cert-manager --version v1.20.0 --destination /his-charts \
    && helm pull oci://ghcr.io/prometheus-community/charts/kube-prometheus-stack --version 86.0.1 --destination /his-charts \
    && helm pull rook-ceph --repo https://charts.rook.io/release --version v1.20.2 --destination /ceph-charts \
    && helm pull rook-ceph-cluster --repo https://charts.rook.io/release --version v1.20.2 --destination /ceph-charts \
    && echo '3eff0bd18151d6e6b1c441463410571443dda1ac78292cb189346628de784f0c  /his-charts/ingress-nginx-4.15.1.tgz' | sha256sum -c - \
    && echo '084e6edb680cf4e2acc30bd496568c53fdf663cbacf6e17876b25785c35b7a13  /his-charts/metrics-server-3.13.1.tgz' | sha256sum -c - \
    && echo '1f1a268fd1642d76d0b9fd162aaedc91973a81b87d9e57c0fff246024ccd2ad4  /his-charts/cert-manager-v1.20.0.tgz' | sha256sum -c - \
    && echo '834c252b3e769516578f6199a374daf688b0bf7b7693089ebbf36aa7dcfd8d0d  /his-charts/kube-prometheus-stack-86.0.1.tgz' | sha256sum -c - \
    && echo '6e0f10f5ca54e618fb90dd149dc9dfbc8a4932955bff2227b692fb32069daf52  /ceph-charts/rook-ceph-v1.20.2.tgz' | sha256sum -c - \
    && echo 'fca482746239bfc9fb2d888f1f5fc206fcc6305934674759f122b011ece87827  /ceph-charts/rook-ceph-cluster-v1.20.2.tgz' | sha256sum -c -

FROM docker.io/library/node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2
ARG OS_MODULE_DESCRIPTOR
ARG OS_MODULE_SIGNATURE
LABEL org.opencontainers.image.title="OpenSphere Cluster Manager" \
      org.opencontainers.image.version="1.3.2" \
      org.opencontainers.image.source="https://github.com/opensphere-platform/OpenSphere-shell-clusterManager" \
      io.opensphere.module.descriptor=$OS_MODULE_DESCRIPTOR \
      io.opensphere.module.descriptor.signature=$OS_MODULE_SIGNATURE \
      io.opensphere.module.descriptor.key-id="opensphere-plugins-v1"
RUN apk upgrade --no-cache
WORKDIR /app
RUN npm install --omit=dev --no-audit --no-fund --no-save ws@8.21.0 js-yaml@4.1.0 \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --chmod=0644 server.js /app/server.js
COPY --chmod=0644 his-manager.js his-catalog.js ceph-manager.js /app/
COPY his-values/ /app/his-values/
COPY --from=helm-assets --chmod=0755 /usr/bin/helm /usr/local/bin/helm
COPY --from=helm-assets /his-charts/ /app/his-charts/
COPY --from=helm-assets /ceph-charts/ /app/ceph-charts/
RUN chmod 0555 /app/his-values /app/his-charts /app/ceph-charts \
    && chmod 0444 /app/his-values/* /app/his-charts/* /app/ceph-charts/*
COPY ui-shell/ /app/plugins/
COPY --chmod=0644 module-package.json module-package.json.sig /app/plugins/
COPY --from=build /app/dist/k8s-console-angular/browser /app/www
# 인증 CA는 이미지에 굽지 않는다. Console Extension Host가 Setup-managed
# opensphere-console-auth-ca Secret을 /etc/opensphere/auth-ca에 read-only로 마운트한다.
ENV PLUGINS_DIR=/app/plugins WWW_DIR=/app/www PORT=8080 \
    NODE_EXTRA_CA_CERTS=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt \
    KANIDM_CA_PATH=/etc/opensphere/auth-ca/ca.crt \
    OSP_CONTROLLER=http://opensphere-console-dupa-controller.opensphere-console.svc.cluster.local:8080
EXPOSE 8080
USER 1000
CMD ["node", "/app/server.js"]
