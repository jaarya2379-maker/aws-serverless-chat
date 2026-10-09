# Real-Time Serverless Chat (AWS WebSocket + Lambda + DynamoDB)

A serverless chat backend using API Gateway WebSocket API, Lambda (Node.js ES Modules, AWS SDK v3) and DynamoDB, deployed with the Serverless Framework to `us-east-1`.

## Project layout

```
.
├── serverless.yml   # Infrastructure, IAM, routes, DynamoDB tables
├── handler.js       # $connect and $disconnect handlers
├── sendMessage.js   # sendMessage route handler (persist + broadcast)
├── package.json     # created in step 2 below
└── README.md
```

## 1. Prerequisites

- **Node.js 18 or higher** (20.x recommended): `node --version`
- **npm**: `npm --version`
- **AWS CLI v2**, configured with credentials that can create CloudFormation, IAM, Lambda, API Gateway and DynamoDB resources:

  ```bash
  aws configure
  # AWS Access Key ID:     <your key>
  # AWS Secret Access Key: <your secret>
  # Default region name:   us-east-1
  # Default output format: json

  aws sts get-caller-identity   # verify credentials work
  ```

- **Serverless Framework**:

  ```bash
  npm install -g serverless
  serverless --version
  ```

- **wscat** (for testing, optional if you use Postman): `npm install -g wscat`

## 2. Install dependencies

Run these inside the project folder (where `serverless.yml` lives):

```bash
npm init -y
npm pkg set type=module
npm install @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb @aws-sdk/client-apigatewaymanagementapi
```

`npm pkg set type=module` is required so Lambda treats `handler.js` and `sendMessage.js` as ES Modules (`import` syntax).

## 3. Deploy

```bash
serverless deploy --region us-east-1
```

When it finishes, copy the WebSocket URL from the output, which looks like:

```
wss://abc123xyz.execute-api.us-east-1.amazonaws.com/dev
```

Tables are created per stage (`chat-connections-dev`, `chat-history-dev` for the default `dev` stage). Deploy another stage with `serverless deploy --stage prod --region us-east-1`.

You can print it again at any time with `serverless info`.

## 4. Test the live WebSocket API

### Option A: wscat

Open two terminals and connect each to your URL. The `room` query parameter picks the room (defaults to `general` if omitted):

```bash
wscat -c "wss://abc123xyz.execute-api.us-east-1.amazonaws.com/dev?room=general"
```

In either terminal, send:

```json
{"action":"sendMessage","chatRoomId":"general","sender":"alice","message":"Hello, world!"}
```

Both terminals receive a broadcast like:

```json
{"messageId":"0d3c...","chatRoomId":"general","sender":"alice","message":"Hello, world!","timestamp":"2026-10-09T12:00:00.000Z"}
```

### Option B: Postman

1. Click **New** → **WebSocket**.
2. Enter your `wss://...?room=general` URL and click **Connect**.
3. In the message box, select **JSON** and send:

   ```json
   {
     "action": "sendMessage",
     "chatRoomId": "general",
     "sender": "alice",
     "message": "Hello, world!"
   }
   ```

4. Open a second WebSocket tab to the same URL to see messages arrive in real time.

### Payload format

| Field        | Type   | Required | Description                                          |
|--------------|--------|----------|------------------------------------------------------|
| `action`     | string | yes      | Must be exactly `sendMessage` (routes the request)   |
| `chatRoomId` | string | yes      | Target room; must match the `?room=` clients connected with to receive it |
| `sender`     | string | yes      | Display name or user ID of the sender                |
| `message`    | string | yes      | The message text                                     |

### Verify stored data

```bash
aws dynamodb query \
  --table-name chat-history-dev \
  --key-condition-expression "chatRoomId = :r" \
  --expression-attribute-values '{":r":{"S":"general"}}' \
  --region us-east-1

aws dynamodb scan --table-name chat-connections-dev --region us-east-1
```

### View logs

```bash
serverless logs -f sendMessageHandler --tail
```

## Behavior notes

- Each connection is stored with the room it joined (`?room=` on connect, default `general`). A message is broadcast only to connections in the payload's `chatRoomId`, found by querying the `RoomIndex` GSI on the connections table, including the sender if they are in that room.
- The `timestamp` sort key in `chat-history` is stored as `<ISO-8601>#<uuid>` so messages sent in the same millisecond never overwrite each other and still sort chronologically.
- If API Gateway returns `GoneException` (HTTP 410) for a connection, it is removed from `chat-connections` immediately.
- Invalid payloads return a JSON `400` error to the sender's HTTP integration response; server faults return `500`.

## Remove the stack

```bash
serverless remove --region us-east-1
```

This deletes all resources, including both DynamoDB tables and their data.
