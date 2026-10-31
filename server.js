import express from 'express';
import Database from 'better-sqlite3';

const VALID_STATUSES = ['backlog', 'in-progress', 'complete'];

const app = express();

app.use(express.json());

// Allow the React frontend (a different origin in development) to call this API.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  return next();
});

app.get('/', (req, res) => {
  return res.status(200).send({'message': 'SHIPTIVITY API. Read documentation to see API docs'});
});

// We are keeping one connection alive for the rest of the life application for simplicity
const db = new Database('./clients.db');

// Don't forget to close connection when server gets terminated
const closeDb = () => db.close();
process.on('SIGTERM', closeDb);
process.on('SIGINT', closeDb);

/**
 * Validate id input
 * @param {any} id
 */
const validateId = (id) => {
  if (Number.isNaN(id)) {
    return {
      valid: false,
      messageObj: {
      'message': 'Invalid id provided.',
      'long_message': 'Id can only be integer.',
      },
    };
  }
  const client = db.prepare('select * from clients where id = ? limit 1').get(id);
  if (!client) {
    return {
      valid: false,
      messageObj: {
      'message': 'Invalid id provided.',
      'long_message': 'Cannot find client with that id.',
      },
    };
  }
  return {
    valid: true,
  };
}

/**
 * Validate priority input
 * @param {any} priority
 */
const validatePriority = (priority) => {
  if (!Number.isInteger(priority) || priority < 1) {
    return {
      valid: false,
      messageObj: {
      'message': 'Invalid priority provided.',
      'long_message': 'Priority can only be positive integer.',
      },
    };
  }
  return {
    valid: true,
  }
}

/**
 * Get all of the clients. Optional filter 'status'
 * GET /api/v1/clients?status={status} - list all clients, optional parameter status: 'backlog' | 'in-progress' | 'complete'
 */
app.get('/api/v1/clients', (req, res) => {
  const status = req.query.status;
  if (status) {
    // status can only be either 'backlog' | 'in-progress' | 'complete'
    if (status !== 'backlog' && status !== 'in-progress' && status !== 'complete') {
      return res.status(400).send({
        'message': 'Invalid status provided.',
        'long_message': 'Status can only be one of the following: [backlog | in-progress | complete].',
      });
    }
    const clients = db.prepare('select * from clients where status = ?').all(status);
    return res.status(200).send(clients);
  }
  const statement = db.prepare('select * from clients');
  const clients = statement.all();
  return res.status(200).send(clients);
});

/**
 * Get a client based on the id provided.
 * GET /api/v1/clients/{client_id} - get client by id
 */
app.get('/api/v1/clients/:id', (req, res) => {
  const id = parseInt(req.params.id , 10);
  const { valid, messageObj } = validateId(id);
  if (!valid) {
    return res.status(400).send(messageObj);
  }
  return res.status(200).send(db.prepare('select * from clients where id = ?').get(id));
});

/**
 * Update client information based on the parameters provided.
 * When status is provided, the client status will be changed
 * When priority is provided, the client priority will be changed with the rest of the clients accordingly
 * Note that priority = 1 means it has the highest priority (should be on top of the swimlane).
 * No client on the same status should not have the same priority.
 * This API should return list of clients on success
 *
 * PUT /api/v1/clients/{client_id} - change the status of a client
 *    Data:
 *      status (optional): 'backlog' | 'in-progress' | 'complete',
 *      priority (optional): integer,
 *
 */
app.put('/api/v1/clients/:id', (req, res) => {
  const id = parseInt(req.params.id , 10);
  const { valid, messageObj } = validateId(id);
  if (!valid) {
    return res.status(400).send(messageObj);
  }

  let { status, priority } = req.body;

  if (status !== undefined && !VALID_STATUSES.includes(status)) {
    return res.status(400).send({
      'message': 'Invalid status provided.',
      'long_message': 'Status can only be one of the following: [backlog | in-progress | complete].',
    });
  }
  if (priority !== undefined) {
    const { valid: priorityValid, messageObj: priorityMessage } = validatePriority(priority);
    if (!priorityValid) {
      return res.status(400).send(priorityMessage);
    }
  }

  const client = db.prepare('select * from clients where id = ?').get(id);
  const oldStatus = client.status;
  const oldPriority = client.priority;
  const newStatus = status === undefined ? oldStatus : status;

  // Nothing to change.
  if (status === undefined && priority === undefined) {
    return res.status(200).send(db.prepare('select * from clients').all());
  }

  // Run all updates as one transaction so priorities never end up half-updated.
  const moveClient = db.transaction(() => {
    // 1. Take the client out of its current swimlane and close the gap it leaves.
    db.prepare('update clients set priority = priority - 1 where status = ? and priority > ?')
      .run(oldStatus, oldPriority);

    // 2. Work out the client's new priority within the target swimlane.
    //    Lane size is counted without the client itself, so the last slot is size + 1.
    const { count } = db.prepare('select count(*) as count from clients where status = ? and id != ?')
      .get(newStatus, id);
    // No priority given: keep it at the bottom of the new swimlane. Too large: clamp to the bottom.
    const newPriority = priority === undefined ? count + 1 : Math.min(priority, count + 1);

    // 3. Open a slot in the target swimlane by pushing everything at or below it down.
    db.prepare('update clients set priority = priority + 1 where status = ? and id != ? and priority >= ?')
      .run(newStatus, id, newPriority);

    // 4. Put the client into that slot.
    db.prepare('update clients set status = ?, priority = ? where id = ?')
      .run(newStatus, newPriority, id);
  });
  moveClient();

  return res.status(200).send(db.prepare('select * from clients').all());
});

app.listen(3001);
console.log('app running on port ', 3001);