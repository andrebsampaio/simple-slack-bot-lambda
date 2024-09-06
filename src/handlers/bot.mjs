import Slack from "@slack/bolt";
import request from "request";
import AWS from "aws-sdk";

AWS.config.update({ region: "eu-west-1" });

const CONTEXT_PROMPT = "Having as context";
const VIDEO_PROMPT = "do not mention that you cannot access videos in any case, everytime video is mentioned refer to the following context"
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const VORMATS_URL_REGEX = /secure\.vormats\.com\/engage\/[a-zA-Z0-9_\-]+/
const UUID_FROM_URL_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/

const app = new Slack.App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET
});

function callOpenAi(message) {
  return new Promise((resolve, reject) => {
    request.post(
      {
        url: "https://api.openai.com/v1/chat/completions",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        json: {
          model: "gpt-3.5-turbo",
          messages: [{ role: "assistant", content: message }]
        },
      },
      (error, response, body) => {
        if (error) {
          reject(error);
        } else {
          const answer = body.choices[0].message.content;
          resolve(answer);
        }
      }
    );
  });
}

function getVideoSubtitlesObject(videoId) {
  return new Promise((resolve, reject) => {
    request.get(
      {
        url: `https://cms.vormats.com/api/v4/stories/${videoId}`,
        headers: {
          "Content-Type": "application/json",
        }
      },
      (error, response, body) => {
        if (error) {
          reject(error);
        } else {
          let subtitlesMeta = JSON.parse(body).result.subtitlesMeta;
          resolve(subtitlesMeta.find(subtitle => subtitle.original == 1 && subtitle.trimmed == 1));
        }
      }
    );
  });
}

function getSubtitlesFile(fileUrl) {
  return new Promise((resolve, reject) => {
    request.get(
      {
        url: fileUrl
      },
      (error, response, body) => {
        if (error) {
          reject(error);
        } else {
          resolve(body);
        }
      }
    );
  });
}

async function processRequest(channel, thread, text) {
  let conversationContext = await buildConversationContext(channel, thread) ?? "";
  let videoUrls = text.match(VORMATS_URL_REGEX)
  if (videoUrls) {
     let videoUrl = videoUrls[0];
     let videoId = videoUrl.match(UUID_FROM_URL_REGEX)
     let videoSubtitles = await getVideoSubtitlesObject(videoId)
     if (videoSubtitles) {
      let subtitlesContent = await getSubtitlesFile(videoSubtitles.srtPath);
      conversationContext += `and ${VIDEO_PROMPT} ${subtitlesContent}` ;
     }
  }

  return callOpenAi(`${conversationContext} ${text}`);
}

async function buildConversationContext(channel, thread) {
  if (!thread) return null;

  let replies = await getConversationReplies(channel, thread);
  if (replies.messages.length > 1) {
    return `${CONTEXT_PROMPT} ${replies.messages.map(m => m["text"] + "\n").join()}`;
  }
  return null;
}

function getConversationReplies(channel, thread) {
  return app.client.conversations.replies({
    channel: channel,
    ts: thread
  });
}

function sendMessage(text, channel, thread) {
  return app.client.chat.postMessage({
    channel: channel,
    thread_ts: thread,
    text: text,
  });
}

async function invokeAnswerFunction(lambdaEvent) {
  lambdaEvent["eventType"] = "answer";

  let params = {
    FunctionName: "BotAnswerFunction",
    InvocationType: "Event",
    Payload: JSON.stringify(lambdaEvent),
  };
  
  return new Promise((resolve, reject) => {
    new AWS.Lambda().invoke(params, function (err, data) {
      if (err) reject(error);
      else resolve(data);
    });
  });
  
}

async function handleEvent(event) {
  let eventType = event["eventType"] ?? "request";
  let slackEvent = JSON.parse(event["body"])["event"];
  let channel = slackEvent["channel"];
  let ts = slackEvent["ts"]
  let thread = slackEvent["thread_ts"];
  if (eventType === "answer") {
    let message = await processRequest(channel, thread, slackEvent["text"]);
    await sendMessage(message, channel, thread ?? ts);
  } else if (
    slackEvent["type"] === "app_mention" ||
    (slackEvent["type"] === "message" && slackEvent["channel_type"] === "im" && !("bot_id" in slackEvent))
  ) {
    await invokeAnswerFunction(event);
  }
}

export const handler = async (event, context, callback) => {
  console.log(event);
  if ('X-Slack-Retry-Num' in event.headers) {
    console.log("Slack retry detected. Skipping run.")
    return { statusCode: 200, body: "Skipping run" };
  } else {
    return await handleEvent(event);
  }
};
