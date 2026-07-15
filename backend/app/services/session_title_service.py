from __future__ import annotations

import asyncio
import re
from collections.abc import Awaitable, Callable, Sequence
from typing import Any

import httpx
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage

from backend.app.agent.factory import AgentFactory, agent_factory
from backend.app.agent.runtime_settings import AutoTitleRuntimeSettings
from backend.app.agent.side_task_model import SideTaskModelError, create_side_task_llm
from backend.app.core.logger import logger
from backend.app.storage import SessionRecord, StorageRepositories

_TITLE_PROMPT = (
    "你是一个对话标题生成器。"
    "请基于给定的首轮用户问题和最终助手回复，生成一个简洁中文会话标题。"
    "要求："
    "1. 仅输出标题本身；"
    "2. 不加引号、不加序号、不加解释；"
    "3. 保持单行；"
    "4. 语义具体，避免使用“问题咨询”“对话记录”这类空泛表达。"
)
_TITLE_FALLBACK_MAX_LENGTH = 50
SESSION_TITLE_LLM_TEMPERATURE = 0.3
SESSION_TITLE_LLM_MAX_TOKENS = 80
_TITLE_TRAILING_PUNCTUATION = "。．.！!？?；;：:、，,~～-—_"
_TITLE_RETRY_DELAYS_SECONDS = (1.0, 2.0)


class SessionTitleService:
    def __init__(
        self,
        repositories: StorageRepositories,
        *,
        factory: AgentFactory = agent_factory,
        http_transport: httpx.BaseTransport | httpx.AsyncBaseTransport | None = None,
        retry_delays: Sequence[float] = _TITLE_RETRY_DELAYS_SECONDS,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._repositories = repositories
        self._factory = factory
        self._http_transport = http_transport
        self._retry_delays = tuple(retry_delays)
        self._sleep = sleep

    async def generate_and_update_session_title(
        self,
        *,
        session_id: str,
        messages: list[BaseMessage],
        settings: AutoTitleRuntimeSettings,
    ) -> SessionRecord | None:
        if not settings.enabled:
            return None
        session = self._repositories.sessions.get(session_id)
        if session is None:
            logger.debug(
                f"[SessionTitleService] 跳过自动标题：session 不存在 | session_id={session_id}"
            )
            return None
        if not self._can_auto_update(session, settings):
            logger.debug(
                f"[SessionTitleService] 跳过自动标题：标题来源不允许覆盖 | "
                f"session_id={session_id} | title_source={session.title_source}"
            )
            return None

        title = await self.generate_title(messages, max_title_length=settings.max_title_length)
        if not title:
            return None

        updated = self._repositories.sessions.update_title_if_auto_allowed(
            session_id,
            title=title,
            only_when_default_title=settings.only_when_default_title,
        )
        if updated is None:
            logger.debug(
                "[SessionTitleService] 跳过自动标题写回：标题已被其他流程修改 | "
                f"session_id={session_id}"
            )
            return None
        logger.info(
            f"[SessionTitleService] 自动标题写回成功 | session_id={session_id} | title={title}"
        )
        return updated

    async def generate_title(
        self,
        messages: list[BaseMessage],
        *,
        max_title_length: int,
    ) -> str | None:
        pair = self.get_first_round_pair(messages)
        if pair is None:
            logger.debug("[SessionTitleService] 跳过自动标题：无法提取首轮 user/assistant 文本")
            return None
        user_text, assistant_text = pair
        prompt = f"用户首轮问题：\n{user_text}\n\n助手最终回复：\n{assistant_text}\n"

        try:
            side_task = create_side_task_llm(
                self._repositories,
                factory=self._factory,
                http_transport=self._http_transport,
                temperature=SESSION_TITLE_LLM_TEMPERATURE,
                max_tokens=SESSION_TITLE_LLM_MAX_TOKENS,
            )
        except SideTaskModelError as exc:
            logger.warning(
                f"[SessionTitleService] 快速模型不可用，跳过自动标题 | "
                f"code={exc.code} | scope={exc.scope} | error={exc}"
            )
            return None

        input_messages = [
            SystemMessage(content=self.title_prompt(max_title_length)),
            HumanMessage(content=prompt),
        ]
        response: Any = None
        for attempt_index in range(len(self._retry_delays) + 1):
            try:
                response = await side_task.llm.ainvoke(input_messages)
                break
            except Exception as exc:
                is_last_attempt = attempt_index >= len(self._retry_delays)
                if is_last_attempt:
                    logger.warning(
                        f"[SessionTitleService] 标题 LLM 调用失败，放弃自动标题 | "
                        f"model={side_task.model} | attempts={attempt_index + 1} | error={exc}"
                    )
                    return None
                delay = self._retry_delays[attempt_index]
                logger.warning(
                    f"[SessionTitleService] 标题 LLM 调用失败，准备重试 | "
                    f"model={side_task.model} | attempt={attempt_index + 1} | "
                    f"next_delay={delay}s | error={exc}"
                )
                await self._sleep(delay)

        raw_title = self.extract_text_content(getattr(response, "content", response))
        title = self.clean_title(raw_title, max_length=_TITLE_FALLBACK_MAX_LENGTH)
        if not title:
            logger.warning("[SessionTitleService] 标题清洗后为空，跳过写回")
            return None
        return title

    @staticmethod
    def filter_title_messages(messages: list[BaseMessage]) -> list[BaseMessage]:
        humans: list[BaseMessage] = []
        last_pure_ai: BaseMessage | None = None
        for message in messages:
            if isinstance(message, HumanMessage):
                humans.append(message)
            elif isinstance(message, AIMessage):
                if getattr(message, "tool_calls", None):
                    last_pure_ai = None
                else:
                    last_pure_ai = message

        result = list(humans)
        if last_pure_ai is not None:
            result.append(last_pure_ai)
        return result

    @classmethod
    def get_first_round_pair(cls, messages: list[BaseMessage]) -> tuple[str, str] | None:
        filtered = cls.filter_title_messages(messages)
        humans = [message for message in filtered if isinstance(message, HumanMessage)]
        if len(humans) != 1:
            return None
        ai_messages = [message for message in filtered if isinstance(message, AIMessage)]
        if not ai_messages:
            return None

        user_text = cls.extract_text_content(humans[0].content)
        assistant_text = cls.extract_text_content(ai_messages[-1].content)
        if not user_text or not assistant_text:
            return None
        return user_text, assistant_text

    @staticmethod
    def extract_text_content(content: Any) -> str:
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            text_parts: list[str] = []
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text":
                    text = item.get("text") or ""
                    if text:
                        text_parts.append(str(text))
            return "".join(text_parts).strip()
        if content is None:
            return ""
        return str(content).strip()

    @staticmethod
    def clean_title(raw_title: str, *, max_length: int) -> str:
        text = (raw_title or "").strip()
        if not text:
            return ""
        text = text.splitlines()[0].strip()
        text = re.sub(r"^[\s\"'“”‘’《》【】\[\](){}]+", "", text)
        text = re.sub(r"[\s\"'“”‘’《》【】\[\](){}]+$", "", text)
        text = text.rstrip(_TITLE_TRAILING_PUNCTUATION).strip()
        text = re.sub(r"\s+", " ", text)
        if max_length > 0 and len(text) > max_length:
            text = text[:max_length].rstrip(_TITLE_TRAILING_PUNCTUATION).strip()
        return text

    @staticmethod
    def title_prompt(expected_title_length: int) -> str:
        return (
            f"{_TITLE_PROMPT}"
            f"5. 标题期望不超过 {expected_title_length} 个中文字符，优先自然完整表达。"
        )

    @staticmethod
    def _can_auto_update(session: SessionRecord, settings: AutoTitleRuntimeSettings) -> bool:
        if session.title_source == "manual":
            return False
        if settings.only_when_default_title and session.title_source != "auto_candidate":
            return False
        return True
