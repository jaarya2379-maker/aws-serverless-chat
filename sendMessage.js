import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';

const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });
const docClient = DynamoDBDocumentClient.from(ddbClient, {
  marshallOptions: { removeUndefinedValues: true },
});

const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE || 'chat-connections';
const HISTORY_TABLE = process.env.HISTORY_TABLE || 'chat-history';
const ROOM_INDEX_NAME = process.env.ROOM_INDEX_NAME || 'RoomIndex';

const response = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const isGoneError = (error) =>
  error?.name === 'GoneException' ||
  error?.$metadata?.httpStatusCode === 410 ||
  error?.statusCode === 410;

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

/**
 * Query the room index of the connections table, following pagination, and return
 * the connection IDs of every client currently joined to the given room.
 */
const getRoomConnectionIds = async (chatRoomId) => {
  const connectionIds = [];
  let exclusiveStartKey;

  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: CONNECTIONS_TABLE,
        IndexName: ROOM_INDEX_NAME,
        KeyConditionExpression: 'chatRoomId = :room',
        ExpressionAttributeValues: { ':room': chatRoomId },
        ProjectionExpression: 'connectionId',
        ExclusiveStartKey: exclusiveStartKey,
      })
    );

    for (const item of result.Items ?? []) {
      connectionIds.push(item.connectionId);
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return connectionIds;
};

export const handler = async (event) => {
  // 1. Parse and validate the incoming payload
  let payload;
  try {
    payload = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
  } catch (error) {
    console.error('Invalid JSON body:', error);
    return response(400, { error: 'Request body must be valid JSON.' });
  }

  const { chatRoomId, sender, message } = payload ?? {};

  if (!isNonEmptyString(chatRoomId) || !isNonEmptyString(sender) || !isNonEmptyString(message)) {
    return response(400, {
      error: 'Payload must include non-empty string fields: chatRoomId, sender, message.',
    });
  }

  try {
    // 2. Persist the message. The sort key combines an ISO timestamp with a short unique
    //    suffix so messages created in the same millisecond never overwrite each other,
    //    while still sorting chronologically.
    const messageId = randomUUID();
    const isoTimestamp = new Date().toISOString();
    const sortKey = `${isoTimestamp}#${messageId}`;

    await docClient.send(
      new PutCommand({
        TableName: HISTORY_TABLE,
        Item: {
          chatRoomId,
          timestamp: sortKey,
          messageId,
          sender,
          message,
        },
      })
    );

    // 3. Gather the active connections joined to this room
    const connectionIds = await getRoomConnectionIds(chatRoomId);

    // 4. Build the API Gateway Management API client from runtime values
    const { domainName, stage } = event.requestContext;
    const apiClient = new ApiGatewayManagementApiClient({
      region: process.env.AWS_REGION || 'us-east-1',
      endpoint: `https://${domainName}/${stage}`,
    });

    const outgoing = JSON.stringify({
      messageId,
      chatRoomId,
      sender,
      message,
      timestamp: isoTimestamp,
    });

    // 5 & 6. Broadcast concurrently; clean up stale connections on GoneException
    const results = await Promise.all(
      connectionIds.map(async (connectionId) => {
        try {
          await apiClient.send(
            new PostToConnectionCommand({ ConnectionId: connectionId, Data: outgoing })
          );
          return { connectionId, delivered: true };
        } catch (error) {
          if (isGoneError(error)) {
            try {
              await docClient.send(
                new DeleteCommand({
                  TableName: CONNECTIONS_TABLE,
                  Key: { connectionId },
                })
              );
              console.log(`Removed stale connection: ${connectionId}`);
            } catch (deleteError) {
              console.error(`Failed to delete stale connection ${connectionId}:`, deleteError);
            }
          } else {
            console.error(`Failed to deliver message to ${connectionId}:`, error);
          }
          return { connectionId, delivered: false };
        }
      })
    );

    const delivered = results.filter((r) => r.delivered).length;

    return response(200, {
      message: 'Message sent.',
      messageId,
      delivered,
      failed: results.length - delivered,
    });
  } catch (error) {
    console.error('Error in sendMessage handler:', error);
    return response(500, { error: 'Failed to send message.', details: error.message });
  }
};
