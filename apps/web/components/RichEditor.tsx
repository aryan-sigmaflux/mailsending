"use client";

import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Braces, ImageIcon, Italic, Link as LinkIcon, List, ListOrdered, Redo2, RectangleHorizontal, Underline, Undo2 } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle } from "react";

/** Link mark that also keeps inline `style` and `data-button` (needed for email-safe CTA buttons). */
const EmailLink = Link.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      style: { default: null, parseHTML: (el) => el.getAttribute("style"), renderHTML: (a) => (a.style ? { style: a.style } : {}) },
      "data-button": { default: null, parseHTML: (el) => el.getAttribute("data-button"), renderHTML: (a) => (a["data-button"] ? { "data-button": a["data-button"] } : {}) },
      "data-notrack": { default: null, parseHTML: (el) => el.getAttribute("data-notrack"), renderHTML: (a) => (a["data-notrack"] != null ? { "data-notrack": "" } : {}) },
    };
  },
}).configure({ openOnClick: false, autolink: true, HTMLAttributes: { rel: null, target: null } });

export const BUTTON_STYLE =
  "display:inline-block;padding:12px 24px;background:#111111;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:600;font-family:Arial,sans-serif";

export interface RichEditorHandle { insert: (text: string) => void; editor: Editor | null }

function Tool({ on, onClick, title, children }: { on?: boolean; onClick: () => void; title: string; children: React.ReactNode }) {
  return <button type="button" className={on ? "on" : ""} onMouseDown={(e) => e.preventDefault()} onClick={onClick} title={title} aria-label={title}>{children}</button>;
}

export const RichEditor = forwardRef<RichEditorHandle, { value: string; onChange: (html: string) => void; onVariables?: () => void }>(
  function RichEditor({ value, onChange, onVariables }, ref) {
    const editor = useEditor({
      immediatelyRender: false,
      extensions: [
        StarterKit.configure({ link: false, heading: false, codeBlock: false, blockquote: false, horizontalRule: false }),
        EmailLink,
        Image.configure({ inline: false }),
        Placeholder.configure({ placeholder: "Hi {{FirstName|there}}, …" }),
      ],
      content: value,
      editorProps: { attributes: { class: "editor", spellcheck: "true" } },
      onUpdate: ({ editor }) => onChange(editor.getHTML()),
    });

    useEffect(() => {
      if (editor && value !== editor.getHTML() && !editor.isFocused) editor.commands.setContent(value, { emitUpdate: false });
    }, [value, editor]);

    useImperativeHandle(ref, () => ({ insert: (t: string) => editor?.chain().focus().insertContent(t).run(), editor }), [editor]);

    if (!editor) return <div className="editor" />;

    const setLink = () => {
      const prev = editor.getAttributes("link").href as string | undefined;
      const url = prompt("Link URL", prev ?? "https://");
      if (url === null) return;
      if (!url) editor.chain().focus().extendMarkRange("link").unsetLink().run();
      else editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    };
    const addButton = () => {
      const label = prompt("Button text", "Book a 15-min call");
      if (!label) return;
      const url = prompt("Button link", "https://");
      if (!url) return;
      editor.chain().focus().insertContent(`<p><a href="${url}" data-button="1" style="${BUTTON_STYLE}">${label}</a></p>`).run();
    };
    const addImage = () => {
      const src = prompt("Image URL (hosted, https://…)");
      if (src) editor.chain().focus().setImage({ src }).run();
    };

    return (
      <div>
        <div className="toolbar">
          <Tool title="Bold" on={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()}><b style={{ fontWeight: 700 }}>B</b></Tool>
          <Tool title="Italic" on={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic /></Tool>
          <Tool title="Underline" on={editor.isActive("underline")} onClick={() => editor.chain().focus().toggleUnderline().run()}><Underline /></Tool>
          <Tool title="Link" on={editor.isActive("link")} onClick={setLink}><LinkIcon /></Tool>
          <Tool title="Bullet list" on={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()}><List /></Tool>
          <Tool title="Numbered list" on={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered /></Tool>
          <Tool title="Image" onClick={addImage}><ImageIcon /></Tool>
          <Tool title="Button" onClick={addButton}><RectangleHorizontal /> Button</Tool>
          {onVariables && <Tool title="Insert variable" onClick={onVariables}><Braces /> Variable</Tool>}
          <span className="flex-1" />
          <Tool title="Undo" onClick={() => editor.chain().focus().undo().run()}><Undo2 /></Tool>
          <Tool title="Redo" onClick={() => editor.chain().focus().redo().run()}><Redo2 /></Tool>
        </div>
        <EditorContent editor={editor} />
      </div>
    );
  },
);
