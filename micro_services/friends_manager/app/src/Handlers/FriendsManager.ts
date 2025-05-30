import db from "../classes/Databases";
import rabbitmq from "../classes/RabbitMQ";
import { JWT } from "../types/common";
import {
  friends_table_name,
  FriendsModel,
  requests_table_name,
  RequestsModel,
} from "../types/DbTables";
import {
  RabbitMQRequest,
  RabbitMQResponse,
  RabbitMQFriendsManagerOp,
  RabbitMQMicroServices,
  NotificationBody,
  NotificationType,
  RabbitMQNotificationsOp,
} from "../types/RabbitMQMessages";

function ListFriends(RMqRequest: RabbitMQRequest): RabbitMQResponse {
  const RMqResponse: RabbitMQResponse = {
    service: RabbitMQMicroServices.FRIENDS_MANAGER,
    req_id: RMqRequest.id,
  } as RabbitMQResponse;
  RMqResponse.status = 200;
  const query = db.persistent.prepare(
    `SELECT friends FROM '${friends_table_name}' WHERE UID = ? ;`
  );
  const res = query.get(RMqRequest.JWT.sub) as FriendsModel;
  if (res && res.friends)
    RMqResponse.message = res.friends;
  else RMqResponse.message = "";
  return RMqResponse;
}

function ListRequests(RMqRequest: RabbitMQRequest): RabbitMQResponse {
  const RMqResponse: RabbitMQResponse = {
    service: RabbitMQMicroServices.FRIENDS_MANAGER,
    req_id: RMqRequest.id,
  } as RabbitMQResponse;
  RMqResponse.status = 200;
  const query = db.persistent.prepare(
    `SELECT * FROM '${requests_table_name}' WHERE to_uid = ? ;`
  );
  const res = query.all(RMqRequest.JWT.sub) as FriendsModel[];
  if (res && res.length > 0) RMqResponse.message = JSON.stringify(res);
  else RMqResponse.message = "[]";
  return RMqResponse;
}

function ListSentRequests(RMqRequest: RabbitMQRequest): RabbitMQResponse {
  const RMqResponse: RabbitMQResponse = {
    service: RabbitMQMicroServices.FRIENDS_MANAGER,
    req_id: RMqRequest.id,
  } as RabbitMQResponse;
  RMqResponse.status = 200;
  const query = db.persistent.prepare(
    `SELECT * FROM '${requests_table_name}' WHERE from_uid = ? ;`
  );
  const res = query.all(RMqRequest.JWT.sub) as FriendsModel[];
  if (res && res.length > 0) RMqResponse.message = JSON.stringify(res);
  else RMqResponse.message = "[]";
  return RMqResponse;
}

// HINT: Assumes RMqRequest.message is a valid user's uid checked for early inside api_gateway
function AddFriendRequest(RMqRequest: RabbitMQRequest): RabbitMQResponse {
  const RMqResponse: RabbitMQResponse = {
    service: RabbitMQMicroServices.FRIENDS_MANAGER,
    req_id: RMqRequest.id,
  } as RabbitMQResponse;
  if (
    !RMqRequest.message ||
    RMqRequest.message === "" ||
    RMqRequest.message === RMqRequest.JWT.sub
  )
    throw `AddFriend(): invalid request`;
  // Check if request already made
  {
    const query = db.persistent.prepare(
      `SELECT REQ_ID FROM '${requests_table_name}' WHERE ( from_uid = ? AND to_uid = ? ) OR ( from_uid = ? AND to_uid = ? ) ;`
    );
    const result = query.get(
      RMqRequest.JWT.sub,
      RMqRequest.message,
      RMqRequest.message,
      RMqRequest.JWT.sub
    ) as RequestsModel;
    if (result) {
      RMqResponse.message = "Friend request already made.";
      RMqResponse.status = 400;
      return RMqResponse;
    }
  }
  // Check if user already friend with uid
  {
    const query = db.persistent.prepare(
      `SELECT friends FROM '${friends_table_name}' WHERE UID = ? ;`
    );
    const result = query.get(RMqRequest.JWT.sub) as FriendsModel;
    if (result && result.friends) {
      const friends = result.friends.split(";");
      if (friends.length > 1) {
        for (let i = 0; i < friends.length; i++) {
          if (friends[i] === RMqRequest.message) {
            RMqResponse.message = "friend already added";
            RMqResponse.status = 400;
            return RMqResponse;
          }
        }
      }
    }
  }
  // Add Friend Request Record to db
  {
    const query = db.persistent.prepare(
      `INSERT INTO '${requests_table_name}' ( REQ_ID , from_uid , to_uid ) VALUES( ? , ? , ? );`
    );
    const result = query.run(
      crypto.randomUUID(),
      RMqRequest.JWT.sub,
      RMqRequest.message
    );
    if (result.changes !== 1) throw `AddFriend(): database error`;
    RMqResponse.message = "friend request sent";
    RMqResponse.status = 200;
  }
  // Ping user if existed
  {
    const Notification: NotificationBody = {
      type: NotificationType.NewFriendRequest,
      from_uid: RMqRequest.JWT.sub,
      to_uid: RMqRequest.message
    }
    const notificationRequest: RabbitMQResponse = {
      req_id: '',
      service: RabbitMQMicroServices.NOTIFICATIONS,
      op: RabbitMQNotificationsOp.PING_USER as number,
      message: JSON.stringify(Notification),
      status: 200
    };
    // Send directly to api gateway to ping the user and avoiding saving the notification to database.
    rabbitmq.sendToAPIGatewayQueue(notificationRequest);
  }
  return RMqResponse;
}

function AcceptFriendRequest(RMqRequest: RabbitMQRequest): RabbitMQResponse {
  const RMqResponse: RabbitMQResponse = {
    service: RabbitMQMicroServices.FRIENDS_MANAGER,
    req_id: RMqRequest.id,
  } as RabbitMQResponse;
  if (!RMqRequest.message || RMqRequest.message === "") {
    RMqResponse.message = "Bad request";
    RMqResponse.status = 400;
    return RMqResponse;
  }
  // Check request is valid
  var request;
  {
    const query = db.persistent.prepare(
      `SELECT * FROM '${requests_table_name}' WHERE REQ_ID = ? AND to_uid = ? ;`
    );
    request = query.get(RMqRequest.message, RMqRequest.JWT.sub) as
      | RequestsModel
      | undefined;
    if (!request) {
      RMqResponse.message = "invalid friend request";
      RMqResponse.status = 400;
      return RMqResponse;
    }
  }
  // Add friend to both users
  {
    db.persistent.exec('BEGIN TRANSACTION;');
    const query = db.persistent.prepare(
      `INSERT INTO '${friends_table_name}' ( UID , friends ) VALUES ( ? , ? ) ON CONFLICT(UID) DO UPDATE SET friends = friends || ';' || ? ;`
    );
    let res = query.run(RMqRequest.JWT.sub, request.from_uid, request.from_uid);
    if (res.changes !== 1) {
      db.persistent.exec('ROLLBACK;');
      throw `AcceptRequest(): database error`;
    }
    res = query.run(request.from_uid, RMqRequest.JWT.sub, RMqRequest.JWT.sub);
    if (res.changes !== 1) {
      db.persistent.exec('ROLLBACK;');
      throw `AcceptRequest(): database error`;
    }
  }
  // Remove request from db
  {
    const query = db.persistent.prepare(
      `DELETE FROM '${requests_table_name}' WHERE REQ_ID = ? ;`
    );
    const result = query.run(request.REQ_ID);
    if (result.changes !== 1) {
      db.persistent.exec('ROLLBACK;');
      throw `AcceptRequest(): database error`;
    }
    db.persistent.exec('COMMIT;');
  }
  // Send a message to notification service
  {
    const Notification: NotificationBody = {
      type: NotificationType.FriendRequestAccepted,
      from_uid: RMqRequest.JWT.sub,
      to_uid: request.from_uid
    }
    const notificationRequest: RabbitMQRequest = {
      id: '',
      op: RabbitMQNotificationsOp.SAVE_NOTIFICATION as number,
      message: JSON.stringify(Notification),
      JWT: RMqRequest.JWT
    };
    rabbitmq.sendToNotificationQueue(notificationRequest);
  }
  RMqResponse.message = "friend request accepted";
  RMqResponse.status = 200;
  return RMqResponse;
}

function DenyFriendRequest(RMqRequest: RabbitMQRequest): RabbitMQResponse {
  const RMqResponse: RabbitMQResponse = {
    service: RabbitMQMicroServices.FRIENDS_MANAGER,
    req_id: RMqRequest.id,
  } as RabbitMQResponse;
  if (!RMqRequest.message || RMqRequest.message === "") {
    RMqResponse.message = "Bad request";
    RMqResponse.status = 400;
    return RMqResponse;
  }
  // Check request is valid
  var request;
  {
    const query = db.persistent.prepare(
      `SELECT * FROM '${requests_table_name}' WHERE REQ_ID = ? ;`
    );
    request = query.get(RMqRequest.message) as RequestsModel | undefined;
    if (!request) {
      RMqResponse.message = "invalid friend request";
      RMqResponse.status = 400;
      return RMqResponse;
    }
    if (request.from_uid !== RMqRequest.JWT.sub && request.to_uid !== RMqRequest.JWT.sub) {
      RMqResponse.message = "permission denied";
      RMqResponse.status = 400;
      return RMqResponse;
    }
  }
  // Remove request from db
  {
    const query = db.persistent.prepare(
      `DELETE FROM '${requests_table_name}' WHERE REQ_ID = ? ;`
    );
    const result = query.run(request.REQ_ID);
    if (result.changes !== 1) throw `DenyFriendRequest(): database error`;
  }
  // Send notification to the sender if deny comes from to_uid
  if (RMqRequest.JWT.sub == request.to_uid) {
    const Notification: NotificationBody = {
      type: NotificationType.FriendRequestDenied,
      from_uid: RMqRequest.JWT.sub,
      to_uid: request.from_uid
    }
    const notificationRequest: RabbitMQRequest = {
      id: '',
      op: RabbitMQNotificationsOp.SAVE_NOTIFICATION as number,
      message: JSON.stringify(Notification),
      JWT: {} as JWT
    };
    rabbitmq.sendToNotificationQueue(notificationRequest);
  }
  RMqResponse.message = "friend request denied";
  RMqResponse.status = 200;
  return RMqResponse;
}

function RemoveFriend(RMqRequest: RabbitMQRequest): RabbitMQResponse {
  const RMqResponse: RabbitMQResponse = {
    service: RabbitMQMicroServices.FRIENDS_MANAGER,
    req_id: RMqRequest.id,
  } as RabbitMQResponse;
  if (
    !RMqRequest.message ||
    RMqRequest.message === "" ||
    RMqRequest.message === RMqRequest.JWT.sub
  ) {
    RMqResponse.message = "Bad request";
    RMqResponse.status = 400;
    return RMqResponse;
  }
  // remove friend from our friend list
  {
    const query = db.persistent.prepare(
      `SELECT friends FROM '${friends_table_name}' WHERE UID = ? ;`
    );
    const res = query.get(RMqRequest.JWT.sub) as FriendsModel;
    if (!res || !res.friends || res.friends === "") {
      RMqResponse.message = "Bad request";
      RMqResponse.status = 400;
      return RMqResponse;
    }
    const friendsArray = res.friends.split(";");
    const friendIndex = friendsArray.indexOf(RMqRequest.message);
    if (friendIndex === -1) {
      RMqResponse.message = "Bad request";
      RMqResponse.status = 400;
      return RMqResponse;
    }
    db.persistent.exec('BEGIN TRANSACTION;');
    friendsArray.splice(friendIndex, 1);
    const updatedFriends = friendsArray.join(";");
    const updateQuery = db.persistent.prepare(
      `UPDATE '${friends_table_name}' SET friends = ? WHERE UID = ? ;`
    );
    const result = updateQuery.run(updatedFriends, RMqRequest.JWT.sub);
    if (result.changes !== 1) throw "Database error";
  }
  // remove us from the other friend's friend list
  {
    const query = db.persistent.prepare(
      `SELECT friends FROM '${friends_table_name}' WHERE UID = ? ;`
    );
    const res = query.get(RMqRequest.message) as FriendsModel;
    if (res && res.friends && res.friends !== "") {
      const friendsArray = res.friends.split(";");
      const friendIndex = friendsArray.indexOf(RMqRequest.JWT.sub);
      if (friendIndex !== -1) {
        friendsArray.splice(friendIndex, 1);
        const updatedFriends = friendsArray.join(";");
        const updateQuery = db.persistent.prepare(
          `UPDATE '${friends_table_name}' SET friends = ? WHERE UID = ? ;`
        );
        const result = updateQuery.run(updatedFriends, RMqRequest.message);
        if (result.changes !== 1) {
          db.persistent.exec('ROLLBACK;');
          throw "Database error";
        }
      }
    }
  }
  db.persistent.exec('COMMIT;');
  {
    const Notification: NotificationBody = {
      type: NotificationType.FriendRemove,
      from_uid: RMqRequest.JWT.sub,
      to_uid: RMqRequest.message
    }
    const notificationRequest: RabbitMQRequest = {
      id: '',
      op: RabbitMQNotificationsOp.SAVE_NOTIFICATION as number,
      message: JSON.stringify(Notification),
      JWT: {} as JWT
    };
    rabbitmq.sendToNotificationQueue(notificationRequest);
  }
  RMqResponse.message = "Friend removed successfully";
  RMqResponse.status = 200;
  return RMqResponse;
}

function PokeFriend(RMqRequest: RabbitMQRequest): RabbitMQResponse {
  const RMqResponse: RabbitMQResponse = {
    service: RabbitMQMicroServices.FRIENDS_MANAGER,
    req_id: RMqRequest.id,
  } as RabbitMQResponse;
  if (
    !RMqRequest.message ||
    RMqRequest.message === "" ||
    RMqRequest.message === RMqRequest.JWT.sub
  ) {
    RMqResponse.message = "Bad request";
    RMqResponse.status = 400;
    return RMqResponse;
  }
  const query = db.persistent.prepare(
    `SELECT friends FROM '${friends_table_name}' WHERE UID = ? ;`
  );
  const res = query.get(RMqRequest.JWT.sub) as FriendsModel;
  if (!res || !res.friends || res.friends === "") {
    RMqResponse.message = "Bad request";
    RMqResponse.status = 400;
    return RMqResponse;
  }
  const friends_uids = res.friends.split(';');
  if (friends_uids.indexOf(RMqRequest.message) == -1) {
    RMqResponse.message = "Bad request";
    RMqResponse.status = 400;
    return RMqResponse;
  }
  const Notification: NotificationBody = {
    type: NotificationType.Poke,
    from_uid: RMqRequest.JWT.sub,
    to_uid: RMqRequest.message
  }
  const notificationRequest: RabbitMQRequest = {
    id: '',
    op: RabbitMQNotificationsOp.SAVE_NOTIFICATION as number,
    message: JSON.stringify(Notification),
    JWT: {} as JWT
  };
  rabbitmq.sendToNotificationQueue(notificationRequest);
  RMqResponse.message = "Poke registred";
  RMqResponse.status = 200;
  return RMqResponse;
}

export function HandleMessage(RMqRequest: RabbitMQRequest): RabbitMQResponse {
  switch (RMqRequest.op) {
    case RabbitMQFriendsManagerOp.LIST_FRIENDS:
      return ListFriends(RMqRequest);
    case RabbitMQFriendsManagerOp.LIST_REQUESTS:
      return ListRequests(RMqRequest);
    case RabbitMQFriendsManagerOp.LIST_SENT_REQUESTS:
      return ListSentRequests(RMqRequest);
    case RabbitMQFriendsManagerOp.ADD_FRIEND:
      return AddFriendRequest(RMqRequest);
    case RabbitMQFriendsManagerOp.ACCEPT_REQUEST:
      return AcceptFriendRequest(RMqRequest);
    case RabbitMQFriendsManagerOp.DENY_REQUEST:
      return DenyFriendRequest(RMqRequest);
    case RabbitMQFriendsManagerOp.REMOVE_FRIEND:
      return RemoveFriend(RMqRequest);
    case RabbitMQFriendsManagerOp.POKE_FRIEND:
      return PokeFriend(RMqRequest);
    default:
      console.log(
        "WARNING: rabbitmq HandleMessage(): operation not implemented."
      );
      throw "operation not implemented";
  }
}

export default HandleMessage;
