from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, TypeAlias

from pydantic import BaseModel, JsonValue as PydanticJsonValue

JsonScalar: TypeAlias = str | int | float | bool | None
JsonValue: TypeAlias = JsonScalar | dict[str, "JsonValue"] | list["JsonValue"]
JsonObject: TypeAlias = dict[str, JsonValue]


@dataclass(slots=True)
class Notification:
    method: str
    payload: JsonObject


@dataclass(slots=True)
class IncomingRequest:
    id: str | int
    method: str
    payload: JsonObject


class ServerInfo(BaseModel):
    name: str
    version: str


class AgentDriverCatalogItem(BaseModel):
    id: str
    name: str


class AgentDriverCatalog(BaseModel):
    defaultId: str
    items: list[AgentDriverCatalogItem]


class InitializeResponse(BaseModel):
    serverInfo: ServerInfo
    drivers: AgentDriverCatalog


class SessionRuntimeCold(BaseModel):
    kind: Literal["cold"]


class SessionRuntimeActivating(BaseModel):
    kind: Literal["activating"]
    phase: str


class SessionRuntimeAvailable(BaseModel):
    kind: Literal["available"]


class SessionRuntimeUnavailableReason(BaseModel):
    code: str
    message: str
    retryable: bool


class SessionRuntimeUnavailable(BaseModel):
    kind: Literal["unavailable"]
    reason: SessionRuntimeUnavailableReason


SessionRuntimeAvailability: TypeAlias = (
    SessionRuntimeCold
    | SessionRuntimeActivating
    | SessionRuntimeAvailable
    | SessionRuntimeUnavailable
)


class SessionRuntimeAttention(BaseModel):
    approvals: int
    userInputs: int


class SessionRuntimeDetail(BaseModel):
    kind: str
    data: PydanticJsonValue


class SessionRuntimeStatus(BaseModel):
    sessionId: str
    driverId: str
    availability: SessionRuntimeAvailability
    activity: Literal["idle", "running"] | None = None
    attention: SessionRuntimeAttention
    operation: str
    detail: SessionRuntimeDetail | None = None
    revision: int
    updatedAt: int


class SessionRuntimeResponse(BaseModel):
    status: SessionRuntimeStatus | None
