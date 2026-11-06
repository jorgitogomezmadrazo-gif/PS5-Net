FROM node:22-slim
WORKDIR /app
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["node","server.js"]
