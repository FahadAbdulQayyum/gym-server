FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache dumb-init

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.js firebase.js ./

ENV NODE_ENV=production
ENV PORT=3847

EXPOSE 3847

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3847)+'/health',(r)=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

USER node

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "index.js"]
