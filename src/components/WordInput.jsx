import { useEffect, useRef, useState } from "react";

export default function WordInput({ onSubmit, disabled }) {
  const [word, setWord] = useState("");
  const inputRef = useRef(null);
  const prevDisabledRef = useRef(disabled);

  useEffect(() => {
    if (prevDisabledRef.current && !disabled) {
      inputRef.current?.focus();
    }
    prevDisabledRef.current = disabled;
  }, [disabled]);

  const submit = () => {
    if (disabled || !word.trim()) return;
    onSubmit(word);
    setWord("");
  };

  return (
    <div className="word-form">
      <input
        ref={inputRef}
        className="word-input"
        placeholder="Enter word"
        value={word}
        onChange={e => setWord(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        disabled={disabled}
      />
      <button
        type="button"
        className="button primary word-submit-button"
        disabled={disabled || !word.trim()}
        onClick={submit}
      >
        Submit
      </button>
    </div>
  );
}
