import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';

const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });
const docClient = DynamoDBDocumentClient.from(ddbClient, {
  marshallOptions: { removeUndefinedValues: true },
});

const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE || 'chat-connections';

const response = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * $connect route: store the connectionId, the room (from ?room=..., default "general")
 * and a connection timestamp.
 */
export const connect = async (event) => {
  try {
    const connectionId = event?.requestContext?.connectionId;
    const requestedRoom = event?.queryStringParameters?.room;
    const chatRoomId =
      typeof requestedRoom === 'string' && requestedRoom.trim().length > 0
        ? requestedRoom.trim()
        : 'general';

    if (!connectionId) {
      return response(400, { error: 'Missing connectionId in request context.' });
    }

    await docClient.send(
      new PutCommand({
        TableName: CONNECTIONS_TABLE,
        Item: {
          connectionId,
          chatRoomId,
          timestamp: new Date().toISOString(),
        },
      })
    );

    return response(200, { message: 'Connected.', connectionId, chatRoomId });
  } catch (error) {
    console.error('Error in $connect handler:', error);
    return response(500, { error: 'Failed to register connection.', details: error.message });
  }
};

/**
 * $disconnect route: remove the matching connectionId record.
 */
export const disconnect = async (event) => {
  try {
    const connectionId = event?.requestContext?.connectionId;

    if (!connectionId) {
      return response(400, { error: 'Missing connectionId in request context.' });
    }

    await docClient.send(
      new DeleteCommand({
        TableName: CONNECTIONS_TABLE,
        Key: { connectionId },
      })
    );

    return response(200, { message: 'Disconnected.', connectionId });
  } catch (error) {
    console.error('Error in $disconnect handler:', error);
    return response(500, { error: 'Failed to remove connection.', details: error.message });
  }
};
