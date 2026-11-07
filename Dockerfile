FROM node:22-slim
WORKDIR /app
COPY . .
# fail the build early, with a clear message, if a proxy file was not uploaded
RUN test -f server.js && test -f psproxy.js && test -f psclient.js || (echo "MISSING FILE: upload server.js, psproxy.js and psclient.js together" && exit 1)
ENV PORT=8080
EXPOSE 8080
CMD ["node","--experimental-vm-modules","--no-warnings","server.js"]
