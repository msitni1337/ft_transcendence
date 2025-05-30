import { JWT } from "./common";

export enum RabbitMQMicroServices {
  API_GATEWAY = 1,
  USER_MANAGER,
  FRIENDS_MANAGER,
  NOTIFICATIONS,
  Leaderboard,
  match_manager,
  chat_manager,
}

export enum RabbitMQUserManagerOp {
  CREATE_GOOGLE = 1,
  CREATE_STANDARD,
  UPDATE,
  DELETE,
  FETCH,
  FETCH_MULTIPLE_INTERNAL,
}

export type UpdateUser = {
  picture_url: string | null;
  bio: string | null;
};

export type RabbitMQRequest = {
  op: RabbitMQUserManagerOp;
  message?: string;
  id: string;
  JWT: JWT;
};

export type RabbitMQResponse = {
  op: RabbitMQUserManagerOp;
  status: number;
  message?: string;
  req_id: string;
  service: RabbitMQMicroServices;
};
