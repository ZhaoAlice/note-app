from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.content import validate_content


def test_structured_rich_text_content_is_accepted() -> None:
    document = {
        "type": "doc",
        "content": [
            {
                "type": "heading",
                "attrs": {"level": 3, "textAlign": "center"},
                "content": [{"type": "text", "text": "本周计划", "marks": [{"type": "underline"}]}],
            },
            {
                "type": "taskList",
                "content": [
                    {
                        "type": "taskItem",
                        "attrs": {"checked": False},
                        "content": [
                            {
                                "type": "paragraph",
                                "content": [{"type": "text", "text": "完成测试", "marks": [{"type": "highlight"}]}],
                            }
                        ],
                    }
                ],
            },
            {"type": "horizontalRule"},
            {
                "type": "table",
                "content": [
                    {
                        "type": "tableRow",
                        "content": [
                            {
                                "type": "tableHeader",
                                "attrs": {"colspan": 1, "rowspan": 1, "colwidth": None},
                                "content": [{"type": "paragraph", "content": [{"type": "text", "text": "事项"}]}],
                            },
                            {
                                "type": "tableCell",
                                "attrs": {"colspan": 1, "rowspan": 1, "colwidth": None},
                                "content": [{"type": "paragraph", "content": [{"type": "text", "text": "进度"}]}],
                            },
                        ],
                    }
                ],
            },
        ],
    }

    encoded, searchable_text = validate_content(document)

    assert '"taskList"' in encoded
    assert searchable_text == "本周计划 完成测试 事项 进度"


@pytest.mark.parametrize(
    "node",
    [
        {"type": "taskItem", "attrs": {"checked": "no"}, "content": [{"type": "paragraph"}]},
        {"type": "paragraph", "attrs": {"textAlign": "start"}},
        {"type": "table", "content": [{"type": "paragraph"}]},
        {
            "type": "tableCell",
            "attrs": {"colspan": 0, "rowspan": 1, "colwidth": None},
            "content": [{"type": "paragraph"}],
        },
        {"type": "paragraph", "content": [{"type": "text", "text": "x", "marks": [{"type": "fontSize"}]}]},
    ],
)
def test_invalid_structured_rich_text_is_rejected(node: dict) -> None:
    with pytest.raises(HTTPException) as exc_info:
        validate_content({"type": "doc", "content": [node]})

    assert exc_info.value.status_code == 422
