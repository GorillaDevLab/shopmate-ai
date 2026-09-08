import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Model output is untrusted: omit HTML and images, and keep the default URL sanitizer. */
export function AssistantMarkdown({ content }: { readonly content: string }) {
  return (
    <div className="assistant-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        disallowedElements={["img"]}
        components={{
          table: ({ children }) => (
            <div
              className="assistant-table-scroll"
              role="region"
              aria-label="数据表格"
              tabIndex={0}
            >
              <table>{children}</table>
            </div>
          ),
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
