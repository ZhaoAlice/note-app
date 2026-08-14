from __future__ import annotations

from copy import deepcopy

from app.content import validate_content
from app.markdown_codec import markdown_to_tiptap, tiptap_to_markdown


def _text(value: str, *marks: dict) -> dict:
    node = {"type": "text", "text": value}
    if marks:
        node["marks"] = list(marks)
    return node


def _replace_image_placeholders(document: dict, replacements: dict[str, str]) -> None:
    def walk(node: dict) -> None:
        if node.get("type") == "image":
            src = node.get("attrs", {}).get("src")
            if src in replacements:
                node["attrs"]["src"] = replacements[src]
        for child in node.get("content", []):
            walk(child)

    walk(document)


def test_tiptap_to_markdown_exports_supported_nodes_and_attachment_paths() -> None:
    document = {
        "type": "doc",
        "content": [
            {
                "type": "heading",
                "attrs": {"level": 2},
                "content": [
                    _text("粗体", {"type": "bold"}),
                    _text("和斜体", {"type": "italic"}),
                ],
            },
            {
                "type": "paragraph",
                "content": [
                    _text("删除", {"type": "strike"}),
                    _text(" "),
                    _text("代码", {"type": "code"}),
                    {"type": "hardBreak"},
                    _text("链接", {"type": "link", "attrs": {"href": "https://example.com"}}),
                ],
            },
            {"type": "blockquote", "content": [{"type": "paragraph", "content": [_text("引用")]}]},
            {"type": "codeBlock", "attrs": {"language": "python"}, "content": [_text("print('ok')")]},
            {"type": "horizontalRule"},
            {
                "type": "bulletList",
                "content": [
                    {"type": "listItem", "content": [{"type": "paragraph", "content": [_text("项目")]}]}
                ],
            },
            {
                "type": "orderedList",
                "attrs": {"start": 3},
                "content": [
                    {"type": "listItem", "content": [{"type": "paragraph", "content": [_text("第三")]}]}
                ],
            },
            {
                "type": "taskList",
                "content": [
                    {
                        "type": "taskItem",
                        "attrs": {"checked": True},
                        "content": [{"type": "paragraph", "content": [_text("完成")]}],
                    }
                ],
            },
            {
                "type": "table",
                "content": [
                    {
                        "type": "tableRow",
                        "content": [
                            {
                                "type": "tableHeader",
                                "attrs": {"colspan": 1, "rowspan": 1, "colwidth": None},
                                "content": [{"type": "paragraph", "content": [_text("列")]}],
                            }
                        ],
                    },
                    {
                        "type": "tableRow",
                        "content": [
                            {
                                "type": "tableCell",
                                "attrs": {"colspan": 1, "rowspan": 1, "colwidth": None},
                                "content": [{"type": "paragraph", "content": [_text("值")]}],
                            }
                        ],
                    },
                ],
            },
            {
                "type": "image",
                "attrs": {"src": "/api/attachments/image-id/content", "alt": "图", "title": "标题"},
            },
        ],
    }

    result = tiptap_to_markdown(document, {"image-id": "attachments/图片 1.png"})

    assert "## **粗体***和斜体*" in result.markdown
    assert "~~删除~~ `代码`  \n[链接](https://example.com)" in result.markdown
    assert "> 引用" in result.markdown
    assert "```python\nprint('ok')\n```" in result.markdown
    assert "- 项目" in result.markdown
    assert "3. 第三" in result.markdown
    assert "- [x] 完成" in result.markdown
    assert "| 列 |\n| --- |\n| 值 |" in result.markdown
    assert '![图](attachments/图片%201.png "标题")' in result.markdown
    assert result.warnings == ()


def test_markdown_to_tiptap_imports_supported_structure_and_validates() -> None:
    markdown = """# 标题

普通 **粗体**、*斜体*、~~删除~~、`代码`和[链接](https://example.com)。  
换行

> 引用

```python
print("ok")
```

---

- 项目
  - 嵌套

3. 第三
4. 第四

- [x] 完成
- [ ] 未完成

| 名称 | 状态 |
| --- | --- |
| 测试 | 通过 |

![本地图](assets/image.png "截图")
"""

    result = markdown_to_tiptap(markdown)
    node_types = [node["type"] for node in result.document["content"]]

    assert node_types == [
        "heading",
        "paragraph",
        "blockquote",
        "codeBlock",
        "horizontalRule",
        "bulletList",
        "orderedList",
        "taskList",
        "table",
        "image",
    ]
    assert result.document["content"][5]["content"][0]["content"][1]["type"] == "bulletList"
    assert result.document["content"][6]["attrs"] == {"start": 3}
    assert [item["attrs"]["checked"] for item in result.document["content"][7]["content"]] == [True, False]
    assert len(result.image_references) == 1
    reference = result.image_references[0]
    assert reference.source_path == "assets/image.png"
    assert reference.alt == "本地图"
    assert reference.title == "截图"

    validated = deepcopy(result.document)
    _replace_image_placeholders(validated, {reference.placeholder: "/api/attachments/imported-id/content"})
    encoded, searchable = validate_content(validated)
    assert '"table"' in encoded
    assert "标题" in searchable
    assert result.warnings == ()


def test_remote_images_become_links_while_relative_images_return_references() -> None:
    result = markdown_to_tiptap(
        "![本地](images/local%20file.png)\n\n![远程](https://example.com/image.png)"
    )

    local, remote = result.document["content"]
    assert local["type"] == "image"
    assert local["attrs"]["src"] == result.image_references[0].placeholder
    assert result.image_references[0].source_path == "images/local file.png"
    assert remote == {
        "type": "paragraph",
        "content": [
            {
                "type": "text",
                "text": "远程",
                "marks": [{"type": "link", "attrs": {"href": "https://example.com/image.png"}}],
            }
        ],
    }
    assert any("remote image" in warning for warning in result.warnings)


def test_lossy_formatting_and_complex_tables_emit_deduplicated_warnings() -> None:
    document = {
        "type": "doc",
        "content": [
            {
                "type": "paragraph",
                "attrs": {"textAlign": "center"},
                "content": [
                    _text("下划线", {"type": "underline"}),
                    _text("高亮", {"type": "highlight"}),
                    _text("仍下划线", {"type": "underline"}),
                ],
            },
            {
                "type": "table",
                "content": [
                    {
                        "type": "tableRow",
                        "content": [
                            {
                                "type": "tableCell",
                                "attrs": {"colspan": 2, "rowspan": 1, "colwidth": [100, 100]},
                                "content": [{"type": "paragraph", "content": [_text("合并")]}],
                            }
                        ],
                    }
                ],
            },
        ],
    }

    exported = tiptap_to_markdown(document)
    imported = markdown_to_tiptap("<u>下划线</u> <mark>高亮</mark>\n\n| A | B |\n| :--- | ---: |\n| one |")

    assert len([warning for warning in exported.warnings if warning.startswith("underline")]) == 1
    assert any("highlight" in warning for warning in exported.warnings)
    assert any("alignment" in warning for warning in exported.warnings)
    assert any("complex table" in warning for warning in exported.warnings)
    assert any("underline HTML" in warning for warning in imported.warnings)
    assert any("highlight HTML" in warning for warning in imported.warnings)
    assert any("table column alignment" in warning for warning in imported.warnings)
    assert any("irregular Markdown table" in warning for warning in imported.warnings)


def test_unsupported_links_and_image_schemes_are_plain_text() -> None:
    result = markdown_to_tiptap(
        "[危险链接](javascript:alert(1))\n\n![内嵌图](data:image/png;base64,AAAA)\n\n| 单列 |\n| --- |\n| 内容 |"
    )

    link_text = result.document["content"][0]["content"][0]
    image_text = result.document["content"][1]["content"][0]
    assert link_text == {"type": "text", "text": "危险链接"}
    assert image_text == {"type": "text", "text": "内嵌图"}
    assert result.document["content"][2]["type"] == "table"
    assert result.image_references == ()
    assert any("unsupported link" in warning for warning in result.warnings)
    assert any("unsupported image source" in warning for warning in result.warnings)


def test_combined_bold_and_italic_marks_round_trip() -> None:
    document = {
        "type": "doc",
        "content": [
            {
                "type": "paragraph",
                "content": [_text("强调", {"type": "bold"}, {"type": "italic"})],
            }
        ],
    }

    markdown = tiptap_to_markdown(document).markdown
    imported = markdown_to_tiptap(markdown)

    assert markdown == "***强调***\n"
    assert imported.document["content"][0]["content"][0] == {
        "type": "text",
        "text": "强调",
        "marks": [{"type": "bold"}, {"type": "italic"}],
    }
