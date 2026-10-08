import { createContext, useContext } from 'react';

/** The "l" key asking the open article to show its label picker. */
export interface LabelPickerRequest {
  articleId: string;
  /** Called once the picker of the article has opened, so that the request is not kept. */
  done: () => void;
}

export const LabelPickerContext = createContext<LabelPickerRequest | null>(null);

/** The request for the label picker; none outside the reader. */
export function useLabelPickerRequest(): LabelPickerRequest | null {
  return useContext(LabelPickerContext);
}
