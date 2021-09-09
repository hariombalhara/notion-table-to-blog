/* eslint-disable no-use-before-define */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-plusplus */
/* eslint-disable camelcase */
import { Client } from "@notionhq/client";
import dotenv from "dotenv";
// eslint-disable-next-line import/no-unresolved
import fs from "node:fs";
import NotionExporter from "notion-exporter";
import { stdout as singleLineLog } from "single-line-log";
import slugify from "slugify";
import matter from "gray-matter";
import { Command } from 'commander';

dotenv.config();

const program = new Command();

program
  .requiredOption('-p --notion_assets_dir_path <path>', 'Path to the Notion assets directory relative to your website root. Assets would be embedded images and videos')
  .requiredOption('-m --markdown_dir_path <path>', 'Path to the dir(relative to current dir) where posts would be stored in markdown format')
  .requiredOption('-i --notion_blog_db_id <id>', 'Notion Database ID having Blogs list')

program.parse(process.argv)
const options  = program.opts();

const NOTION_ASSETS_PATH_RELATIVE_TO_ROOT_OF_WEBSITE = options.notion_assets_dir_path
const NOTION_MY_BLOG_DATABASE_ID = options.notion_blog_db_id;
const POSTS_LOCATION = options.markdown_dir_path

const {NOTION_TOKEN, NOTION_INTEGRATION_TOKEN} = process.env;

if (!NOTION_INTEGRATION_TOKEN) {
    // Create an integration and share your Notion DB Page with it. See https://developers.notion.com/docs to know how to do it.
    throw new Error("Provide NOTION_INTEGRATION_TOKEN env variable. See https://developers.notion.com/docs to know how to do it");
}

if (!NOTION_TOKEN) {
  // See how to get it https://github.com/yannbolliger/notion-exporter#how-to-retrieve-the-notion_token
  throw new Error("Provide NOTION_TOKEN env variable. See how to get it https://github.com/yannbolliger/notion-exporter#how-to-retrieve-the-notion_token");
}


function log(...args) {
    console.log(...args);
}

const progressiveLog = function (...args) {
    let progressIndicator = "...";
    if (!args.join("").length) {
        progressIndicator = "";
    }
    singleLineLog.apply(console, [...args].concat(progressIndicator));
};

const notion = new Client({ auth: NOTION_INTEGRATION_TOKEN });

async function getPostsList() {
    let cursor;
    const pages = [];
    while (true) {
        progressiveLog("Fetching Posts List");
        // eslint-disable-next-line no-await-in-loop
        const { results, next_cursor } = await notion.databases.query({
            database_id: NOTION_MY_BLOG_DATABASE_ID,
            start_cursor: cursor,
        });
        pages.push(...results);
        cursor = next_cursor;
        if (!cursor) {
            break;
        }
    }
    return pages;
}

/**
 * Notion serves markdown with frontmatter but it is not present b/w --- --- which causes front matter to be considered part of the blog.
 * This function fixed that frontmatter.
 * @param {*} markdown 
 * @returns 
 */
function getMarkdownWithFrontMatter(markdown){
  const [title, frontmatter, ...content] = markdown.split('\n\n')
  return `---\n${frontmatter}\ntitle: ${title.replace('#', '')}\n---\n\n${content.join('\n\n')}`
}

const unpublishedPosts = [];
async function getPosts({
    publishedOnly = true,
    shouldFetchPost = () => true,
}) {
    const pages = await getPostsList();
    const filteredPages = [];

    // eslint-disable-next-line no-underscore-dangle
    const _shouldFetchPost = (page) => {
        if (!page.properties.published.checkbox && publishedOnly) {
            unpublishedPosts.push(page);
            return false;
        }
        return shouldFetchPost(page);
    };

    for (let i = 0; i < pages.length; i++) {
        const page = pages[i];

        // eslint-disable-next-line no-use-before-define 
        if (_shouldFetchPost(page)) {
          progressiveLog(`Fetching Page "${getPostTitle(page)}"`);

            // eslint-disable-next-line no-await-in-loop
            // eslint-disable-next-line new-cap
            const notionExporter = new NotionExporter.default(
                NOTION_TOKEN
            );
            const zip = await notionExporter.getZipUrl(page.id).then(notionExporter.getZip)
            let markdown = null;
            // eslint-disable-next-line no-loop-func
            zip.getEntries().forEach((zipEntry) => {
              if(!zipEntry.entryName.endsWith('.md')) {
                  const folderName = zipEntry.entryName.split('/')[0]
                  zip.extractEntryTo(zipEntry.entryName, `./static/notion/${encodeURIComponent(folderName)}`,false, true/* override */)
              } else {
                markdown = zipEntry.getData().toString().trim();
                // Fix Broken Image embedding in markdown
                // Convert [ABC.webp](/Easiest%20and%20Reliable%20way%20to%20identify%20the%20last%20acti%20761668d0e209475595a4da1bbfea1178/pexels-markus-spiske-1089440.webp) => ![ABC.webp](/notion/Easiest%20and%20Reliable%20way%20to%20identify%20the%20last%20acti%20761668d0e209475595a4da1bbfea1178/pexels-markus-spiske-1089440.webp) 
                // eslint-disable-next-line prefer-arrow-callback
                markdown = markdown.replace(/\[(.*?(?:webp|png|avif|jpg|jpeg|gif|mp4|webm))\](\s*)\((.*?)\)/g,function (match, p1, p2, p3) {
                  // If the path is an absolute URL, don't change it
                  if (!match.includes('https://')) {
                    return `[${p1}](/${NOTION_ASSETS_PATH_RELATIVE_TO_ROOT_OF_WEBSITE}/${p3})`
                  }
                  return match
                })
              }
            })
           
            pages[i].markdown = getMarkdownWithFrontMatter(markdown)
            filteredPages.push(page);
        }
    }
    return filteredPages;
}

function getPostTitle(post) {
    return post.properties.Name.title[0].text.content;
}

function getPostPath(postSlug, postsLocation) {
    return `${postsLocation}/${postSlug}.md`;
}

function getSlug(post) {
    return slugify(getPostTitle(post).replace(/\//g,'-')).replace(/[_![\]]/g, "").replace(/[.()/]/g,'-').replace(/-*$/,'').toLowerCase();
}

async function writePosts(postsLocation) {
    const skippedPosts = [];
    const writtenPosts = [];
    const posts = await getPosts({
        publishedOnly: true,
        shouldFetchPost: (post) => {
            const postSlug = getSlug(post);
            const postPath = getPostPath(postSlug, postsLocation);
            let shouldUpdatePost = false;
            if (fs.existsSync(postPath)) {
                const {data:{lastModifiedTs:postLastModifiedTs}}  = matter(fs.readFileSync(postPath, 'utf8'));
                if (postLastModifiedTs < new Date(post.properties.lastModifiedTs.formula.number)) {
                    shouldUpdatePost = true;
                } else {
                    shouldUpdatePost = false;
                    progressiveLog(
                        `Skipped Post "${postSlug}", is already up to date`
                    );
                }
            } else {
                shouldUpdatePost = true;
            }
            if (!shouldUpdatePost) {
                skippedPosts.push(post);
            }
            return shouldUpdatePost;
        },
    });

    progressiveLog(`Creating ${postsLocation} if it doesn't exist`);

    if (!fs.existsSync(postsLocation)) {
        fs.mkdirSync(postsLocation, { recursive: true });
    }

    posts.forEach((post) => {
        const postSlug = getSlug(post);
        const postPath = getPostPath(postSlug, postsLocation);

        fs.writeFileSync(postPath, post.markdown);
        writtenPosts.push({slug: postSlug, title:getPostTitle(post)})
        progressiveLog('Writing Post:"', postPath, '"');
    });

    progressiveLog("");
    log("Markdown Posts available in", postsLocation);
    if (skippedPosts.length) {
        log(`\nTotal ${skippedPosts.length} Posts were Skipped:
${skippedPosts.map((post) => `- ${getPostTitle(post)}`).join("\n")}    
      `);
    }

    if (writtenPosts.length) {
      log(`\nTotal ${writtenPosts.length} Posts were Written:
${writtenPosts.map((post) => `- ${post.title} => ${post.slug}`).join("\n")}    
      `);
    }

    if (unpublishedPosts.length) {
      log(`\nTotal ${unpublishedPosts.length} Posts were Unpublished:
${unpublishedPosts.map((page) => `- ${getPostTitle(page)}`).join("\n")}    
      `);
    }
}

await writePosts(POSTS_LOCATION);
