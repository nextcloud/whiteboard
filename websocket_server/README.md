## Standalone websocket server for Nextcloud Whiteboard

This is a standalone websocket server for the Nextcloud Whiteboard app. It is intended to be used as a standalone service that can be run in a container.

### Usage

The server requires the `NEXTCLOUD_URL` environment variable to be set to the URL of the Nextcloud instance that the Whiteboard app is installed on. The server will connect to the Nextcloud instance and listen for whiteboard events.

The server can be run in a container using the following command:

```bash
docker run -e NEXTCLOUD_URL=https://nextcloud.local --rm nextcloud-whiteboard-server
```

Docker compose can also be used to run the server:

```yaml
version: '3.7'
services:
  nextcloud-whiteboard-server:
    image: nextcloud-whiteboard-server
    ports:
      - 3002:3002
    environment:
      - NEXTCLOUD_URL=https://nextcloud.local
      - JWT_SECRET_KEY=some-random-key
      
```

### Building the image

The image can be built using the following command:

```bash
docker build -t nextcloud-whiteboard-server -f Dockerfile ../
```
