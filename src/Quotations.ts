import { findDelimiter, splitLines, matchStart } from "./Utils";
import * as TalonRegexp from "./Regexp";
import * as TalonConstants from "./Constants";
  
/*
  * Module interface.
  */

/**
 * Extracts a non quoted message from the provided message body.
 * @param {string} messageBody - The string to extract the message from.
 * @param {string} contentType - The MIME content type for the specified body.
 * @return {string} The extracted, non-quoted message.
 */
export function extractFrom(messageBody: string, contentType: TalonConstants.ContentType = TalonConstants.ContentTypeTextPlain): string {    
  // Depending on the content-type, use the appropriate method.
  switch (contentType) {
    case "text/plain":
      return extractFromPlain(messageBody);
    case "text/html":
      return extractFromHtml(messageBody);
    default:
      return messageBody;
  }
}

/** 
 * Extracts a non quoted message from the provided plain text.
 * @param {string} messageBody - The plain text body to extract the message from.
 * @return {string} The extracted, non-quoted message.
 */
export function extractFromPlain(messageBody: string): string {
  // Prepare the provided message body.
  const delimiter = findDelimiter(messageBody);
  messageBody = preprocess(messageBody, delimiter);
  
  // Only take the X first lines.
  const lines = splitLines(messageBody).slice(0, TalonConstants.MaxLinesCount);
  const markers = markMessageLines(lines);
  const { lastMessageLines } = processMarkedLines(lines, markers);
  
  // Concatenate the lines, change links back, strip and return.
  messageBody = lastMessageLines.join(delimiter);
  messageBody = postProcess(messageBody);
  
  // Return the extracted message.
  return messageBody;
}

/**
 * Extracts a non quoted message from the provided html.
 * @param {string} messageBody - The html body to extract the message from.
 * @return {string} The extracted, non-quoted message.
 */
export function extractFromHtml(messageBody: string): string {
  return messageBody;
}
  
/*
  * Private methods.
  */

/**
 * Prepares the message body for being stripped.
 * 
 * Replaces link brackets so that they won't be mistaken for quotation markers.
 * Splits lines in two if the splitter pattern is preceeded by some text on the same line.
 * (done only for the "On <date> <person> wrote:" pattern).
 * 
 * @param {string} messageBody - The message body to process.
 * @param {string} delimiter - The delimiter for lines in the provided body.
 * @param {string} contentType - The MIME content type of the provided body.
 * @return {string} The pre-processed message body.
 */
function preprocess(messageBody: string, delimiter: string, contentType: TalonConstants.ContentType = TalonConstants.ContentTypeTextPlain): string {  
  // Normalize links. i.e. replace "<", ">" wrapping the link with some symbols
  // so that ">" closing the link won't be mistaken for a quotation marker.   
  messageBody = messageBody.replace(TalonRegexp.Link, (match: string, link: string, offset: number, str: string): string => {
    const newLineIndex = str.substring(offset).indexOf("\n");
    return str[newLineIndex + 1] === ">" ? match : `@@${link}@@`; 
  });
  
  // If this is an HTML message, we're done here.
  if (contentType !== TalonConstants.ContentTypeTextPlain)
    return messageBody;
    
  // Otherwise, wrap splitters with new lines.
  messageBody = messageBody.replace(TalonRegexp.OnDateSomebodyWrote, (match: string, ...args: any[]) => {
    const offset = args.filter(a => isFinite(a))[0];
    const str = args[args.length - 1];
    
    return offset > 0 && str[offset - 1] !== "\n"
      ? delimiter + match
      : match;
  });
  
  return messageBody;
}
  
/** 
 * Mark message lines with markers to distinguish quotation lines.
 * 
 * Markers:
 * 
 * e - empty line.
 * m - line that starts with quotation marker '>'
 * s - splitter line.
 * t - presumably lines from that last message in the conversation.
 * 
 * @params {string[]} lines - Array of lines to mark.
 * @result {string} Array of markers as a single string.
 */
function markMessageLines(lines: string[]): string {
  const markers = new Array<string>(lines.length);
  
  // For each line, find the corresponding marker.
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    
    // Empty line.
    if (!line) {
      markers[index] = "e";
    // Line with a quotation marker.
    } else if (matchStart(line, TalonRegexp.QuotePattern)) {
      markers[index] = "m";
    // Forwarded message.
    } else if (matchStart(line, TalonRegexp.Forward)) {
      markers[index] = "f";
    } else {
      // Try to find a splitter spread on several lines.
      const splitterMatch = isSplitter(lines.slice(index, index + TalonConstants.SplitterMaxLines).join("\n"));
      
      // If none was found, assume it's a line from the last message in the conversation.
      if (!splitterMatch) {
        markers[index] = "t";
      // Otherwise, append as many splitter markers, as lines in the splitter.
      } else {
        const splitterLines = splitLines(splitterMatch[0]);
        for (let splitterIndex = 0; splitterIndex < splitterLines.length; splitterIndex++)
          markers[index + splitterIndex] = "s";
          
        // Skip as many lines as we just updated.
        index += splitLines.length - 1;
      }        
    }
    
    index++;
  }    
  
  return markers.join("");
}
  
/**
 * Run regexes against the message's marked lines to strip quotations.
 * Returns only the last message lines.
 * 
 * @param {string[]} lines - Array of lines to process.
 * @param {string} markers - Array of markers for the specified lines.
 * @return {string[]} The lines for th
 */
function processMarkedLines(lines: string[], markers: string): {
  lastMessageLines: string[],
  wereLinesDeleted: boolean,
  firstDeletedLine: number,
  lastDeletedLine: number
} {
  const result = {
    lastMessageLines: lines,
    wereLinesDeleted: false,
    firstDeletedLine: -1,
    lastDeletedLine: -1
  };
  
  // If there are no splitters, there should be no markers.
  if (markers.indexOf("s") < 0 && !/(me*){3}/.exec(markers))
    markers.replace("m", "t");
  
  if (matchStart(markers, /[te]*f/))
    return result;
    
  // Inlined reply.
  // Use lookbehind assertions to find overlapping entries. e.g. for "mtmtm".
  // Both "t" entries should be found.
  let inlineReplyMatch: any;
  while (inlineReplyMatch = /(m)e*((?:t+e*)+)m/g.exec(markers)) {    
    // Long links could break a sequence of quotation lines,
    // but they shouldn't be considered an inline reply.
    const links = lines[inlineReplyMatch[3]].match(TalonRegexp.ParenthesisLink)
      || matchStart(lines[inlineReplyMatch[3] + 1].trim(), TalonRegexp.ParenthesisLink)

    if (!links)
      return result;
  }
  
  // Cut out text lines coming after the splitter if there are no markers there.
  let quotation: any = markers.match("(se*)+((t|f)+e*)+");
  if (quotation) {
    result.wereLinesDeleted = true;
    result.firstDeletedLine = quotation[3];
    result.lastDeletedLine = lines.length;
    result.lastMessageLines = lines.slice(0, quotation[3]);
    return result;
  }
  
  // Handle the case with markers.
  quotation = markers.match(TalonRegexp.Quotation)
    || markers.match(TalonRegexp.EmptyQuotation);
  
  if (quotation) {
    const firstGroupStart = quotation.index + quotation[0].indexOf(quotation[1]);
    const firstGroupEnd = firstGroupStart + quotation[1].length;
    
    result.wereLinesDeleted = true;
    result.firstDeletedLine = firstGroupStart;
    result.lastDeletedLine = firstGroupEnd;
    result.lastMessageLines = lines.slice(0, firstGroupStart).concat(lines.slice(firstGroupEnd));
    return result;
  }  
      
  return result;
}
  
/**
 * Make up for changes made while preprocessing the message.
 * Convert link brackets back to "<" and ">".
 */
function postProcess(messageBody: string): string {
  return messageBody.replace(TalonRegexp.NormalizedLink, "<$1>").trim();
}

/**
 * Returns a Regexp match if the provided string is a splitter.
 * @param {string} src - The string to search.
 * @return {RegExpMatchArray} The match for the splitter that was found, if any.
 */
function isSplitter(src: string): RegExpMatchArray {
  for (let pattern of TalonRegexp.SplitterPatterns) {
    var match = matchStart(src, pattern);
    if (match)
      return match;
  }
}