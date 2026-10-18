FROM alpine:3.23
ARG TECTONIC_VERSION=0.16.9

RUN set -eux; \
  case "$(apk --print-arch)" in \
    aarch64) target=aarch64-unknown-linux-musl; sha=f9aa39017dbd51f111fdb93dda222178cbe51c8193508fc567b523cc74fff9c1;; \
    x86_64) target=x86_64-unknown-linux-musl; sha=60b13a0826ae7ad9ce34b4a2df06bff2cfcfa6dda8a915477c0cbb84e1a4a902;; \
    *) echo "Unsupported architecture" >&2; exit 1;; \
  esac; \
  url="https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/tectonic-${TECTONIC_VERSION}-${target}.tar.gz"; \
  wget -O /tmp/tectonic.tgz "$url"; \
  echo "$sha  /tmp/tectonic.tgz" | sha256sum -c -; \
  tar -xzf /tmp/tectonic.tgz -C /usr/local/bin tectonic; \
  rm /tmp/tectonic.tgz; \
  addgroup -S -g 10001 tectonic; \
  adduser -S -D -u 10001 -G tectonic -h /home/tectonic tectonic; \
  mkdir -p /work /var/cache/tectonic /etc/fonts /usr/share/fonts /tmp/font-cache; \
  chown -R tectonic:tectonic /work /var/cache/tectonic /tmp/font-cache

RUN printf '%s\n' \
  '<?xml version="1.0"?><fontconfig>' \
  '<dir>/usr/share/fonts</dir><cachedir>/tmp/font-cache</cachedir>' \
  '</fontconfig>' > /etc/fonts/fonts.conf

ENV HOME=/home/tectonic \
    TECTONIC_CACHE_DIR=/var/cache/tectonic
USER tectonic
WORKDIR /work

RUN printf '%s\n' \
  '\documentclass{article}' \
  '\usepackage{amsmath,amssymb,graphicx,xcolor,hyperref}' \
  '\begin{document}Overroot $x^2$\end{document}' >/tmp/warm.tex \
  && tectonic -X compile --untrusted --outdir /tmp /tmp/warm.tex \
  && rm -f /tmp/warm.*

CMD ["sleep", "infinity"]
