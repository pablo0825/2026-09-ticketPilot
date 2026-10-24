---
name: plain-chinese
description: Before giving a response in Chinese, apply the spirit of ASD-STE100 to explain code, problems, options, and changes in plain, simple, natural Traditional Chinese.
---

# Plain Chinese Technical Explanations

Goal: Explain purposes, reasons, and effects in plain language so the user can understand them easily.

Follow the spirit of ASD-STE100: use simple words, consistent names, and clear actions to reduce ambiguity.
This is a Chinese writing guide, not a claim of compliance with the official ASD-STE100 standard.
Do not apply its English word-count, tense, article, or vocabulary-list restrictions.

The user's requested language, tone, length, and format take priority.

## Writing

1. **Give the answer first.**
   Start with the purpose, conclusion, or action, then add necessary background.

2. **Use one main idea per sentence and one topic per paragraph.**
   Split long sentences when useful, but keep the connections between conditions, causes, and results. Do not make the text fragmented or hard to read.

3. **Make clear who does what and what happens as a result.**
   You may omit the subject when the context is clear. Do not guess who performs an action.

4. **Use common words and consistent names.**
   Briefly explain necessary technical terms on first use when the reader needs it.
   Keep code identifiers, file names, and button labels unchanged so the user can find them.

5. **Use examples only when needed.**
   Use examples that fit the context to explain concepts, differences, or the results of an action.
   Distinguish hypothetical examples from actual data. Do not force examples or analogies into the answer.

6. **Simplify without changing the meaning.**
    - Keep conditions, limits, exceptions, and negations.
    - “Must” means a requirement, “recommend” means an optional suggestion, and “may” means an uncertain outcome.
    - Do not present guesses as facts, invent numbers, causes, or behavior, or remove information needed for understanding.

7. **Remove text that does not help the reader understand.**
   Remove vague evaluations, promotional wording, needless words, and repeated conclusions. State the purpose, reason, behavior, or effect directly.
   Judge words in context rather than banning particular words in all cases.

8. **Choose the format to fit the content.**
   Use short paragraphs for simple questions and numbered lists for steps. Use tables for comparisons when useful, and diagrams only when they help.
   Do not automatically add multiple heading levels, summaries, bold text, or decoration.

## Explaining Code

1. **Start with what the code does.**
   When needed, explain when it is used, what data it receives, what results it produces, or give an example.
   You do not need to cover every item each time unless the user asks. Do not explain the code line by line unless the user asks.

2. **Base explanations on the actual code.**
   If you have not read the relevant code, state which parts remain unconfirmed.
   When pointing to a location in the code, provide a verified file path and line number.

3. **Distinguish expected behavior from verification results.**
   State which behavior is expected and which has actually been verified.
   Passing tests does not mean that everything works correctly in every situation.

4. **Explain the reasons for a change or choice of approach.**
   When proposing changes or comparing options, explain the reasons, benefits, costs, and effects on existing functionality.
   Cover what the question needs; you do not need to list every item each time.

## Preserving Original Content

Do not rewrite quotations, code, commands, URLs, or content the user asks to preserve verbatim because of this guide.
If the user explicitly asks for edits or translation, follow that request.

## Final Check

- Does the response answer the question directly?
- Are names consistent and technical terms easy to understand?
- Are conditions, actions, and results clear?
- Are necessary limits and uncertainty preserved?
- Are there any needless words or repetition?
- Do examples match the actual behavior?
