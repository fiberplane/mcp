import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  InMemoryClientRequestAdapter,
  InMemorySessionAdapter,
  McpServer,
  StreamableHttpTransport,
} from "mcp-lite";
import { z } from "zod";

const mcp = new McpServer({
  name: "comprehensive-mcp-demo",
  version: "2.0.0",
  schemaAdapter: (s) => z.toJSONSchema(s as z.ZodType),
});

// ===== MIDDLEWARE =====
mcp.use(async (ctx, next) => {
  const startTime = Date.now();
  console.log(
    `[${new Date().toISOString()}] ${ctx.request.method} - Request ID: ${ctx.requestId}`,
  );

  ctx.state.startTime = startTime;
  await next();

  const duration = Date.now() - (ctx.state.startTime as number);
  console.log(
    `[${new Date().toISOString()}] ${ctx.request.method} completed in ${duration}ms`,
  );
});

mcp.use(async (_ctx, next) => {
  try {
    await next();
  } catch (error) {
    console.error("Middleware caught error:", error);
    throw error;
  }
});

mcp.use(async (ctx, next) => {
  ctx.state.rateLimited = false;

  const requestCount = (ctx.state.requestCount as number) || 0;
  if (requestCount > 100) {
    ctx.state.rateLimited = true;
    throw new Error("Rate limit exceeded");
  }
  ctx.state.requestCount = requestCount + 1;
  await next();
});

mcp.use(async (ctx, next) => {
  const params = (ctx.request.params as Record<string, unknown>) || {};
  ctx.state.authenticated = params.apiKey === "demo-key" || true;
  await next();
});

// ===== TOOLS =====
const echoSchema = z.object({
  message: z.string().min(1, "Message cannot be empty"),
  repeat: z.number().min(1).max(10).optional().default(1),
});

mcp.tool("echo", {
  description: "Echoes a message with optional repetition",
  inputSchema: echoSchema,
  handler: (args) => ({
    content: [
      {
        type: "text",
        text: Array(args.repeat).fill(args.message).join(" "),
      },
    ],
  }),
});

const addSchema = z.object({
  a: z.number(),
  b: z.number(),
});

mcp.tool("add", {
  description: "Adds two numbers together",
  inputSchema: addSchema,
  handler: (args) => ({
    content: [
      {
        type: "text",
        text: `${args.a} + ${args.b} = ${args.a + args.b}`,
      },
    ],
  }),
});

const multiplySchema = z.object({
  numbers: z.array(z.number()).min(1, "At least one number required"),
  precision: z.number().min(0).max(10).optional().default(2),
});

mcp.tool("multiply", {
  description: "Multiplies multiple numbers with optional precision",
  inputSchema: multiplySchema,
  handler: ({ precision = 0, numbers }) => {
    const result = numbers.reduce((acc, num) => acc * num, 1);
    const formatted =
      precision > 0 ? result.toFixed(precision) : result.toString();

    return {
      content: [
        {
          type: "text",
          text: `${numbers.join(" × ")} = ${formatted}`,
        },
      ],
    };
  },
});

const weatherSchema = z.object({
  location: z.string().min(1, "Location is required"),
  unit: z.enum(["celsius", "fahrenheit", "kelvin"]).default("celsius"),
  includeHumidity: z.boolean().optional().default(false),
});

mcp.tool("getWeather", {
  description: "Gets weather information for a location",
  inputSchema: weatherSchema,
  handler: (args) => {
    const baseTemp = Math.floor(Math.random() * 30) + 10;
    let temp = baseTemp;
    let unit = "°C";

    if (args.unit === "fahrenheit") {
      temp = Math.round((baseTemp * 9) / 5 + 32);
      unit = "°F";
    } else if (args.unit === "kelvin") {
      temp = Math.round(baseTemp + 273.15);
      unit = "K";
    }

    const conditions = ["sunny", "cloudy", "rainy", "snowy"][
      Math.floor(Math.random() * 4)
    ];
    let response = `Weather in ${args.location}: ${temp}${unit}, ${conditions}`;

    if (args.includeHumidity) {
      const humidity = Math.floor(Math.random() * 100);
      response += `, humidity: ${humidity}%`;
    }

    return {
      content: [
        {
          type: "text",
          text: response,
        },
      ],
    };
  },
});

const imageSchema = z.object({
  color: z.enum(["red", "green", "blue", "yellow"]).default("blue"),
  size: z.enum(["small", "medium", "large"]).default("small"),
});

mcp.tool("getTinyImage", {
  description: "Returns a tiny base64 encoded image",
  inputSchema: imageSchema,
  handler: (args) => {
    const tinyPng =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

    return {
      content: [
        {
          type: "image",
          data: tinyPng,
          mimeType: "image/png",
        },
        {
          type: "text",
          text: `Generated a tiny ${args.size} ${args.color} image`,
        },
      ],
    };
  },
});

const longRunningOperationSchema = z.object({
  duration: z
    .number()
    .default(10)
    .describe("Duration of the operation in seconds"),
  steps: z.number().default(5).describe("Number of steps in the operation"),
});

const annotatedSchema = z.object({
  title: z.string(),
  includeImage: z.boolean().default(true),
  includeResource: z.boolean().default(true),
});

mcp.tool("longRunningOperation", {
  description: "Demonstrates a long running operation with progress updates",
  inputSchema: longRunningOperationSchema,
  handler: async (args, ctx) => {
    const duration = args.duration ?? 10;
    const steps = args.steps ?? 5;
    const stepDuration = duration / steps;

    for (let i = 1; i < steps + 1; i++) {
      // Simulate work
      await new Promise((resolve) => setTimeout(resolve, stepDuration * 1000));

      // Report progress using ctx.progress()
      if (ctx.progressToken && ctx.progress) {
        await ctx.progress({
          progress: i,
          total: steps,
          message: `Step ${i} of ${steps} completed`,
        });
      }
    }

    return {
      content: [
        {
          type: "text",
          text: `Long running operation completed. Duration: ${duration} seconds, Steps: ${steps}.`,
        },
      ],
    };
  },
});

mcp.tool("annotatedMessage", {
  description: "Returns a rich message with multiple content types",
  inputSchema: annotatedSchema,
  handler: (args) => {
    return {
      content: [
        {
          type: "text",
          text: `# ${args.title}\n\nThis is a comprehensive response demonstrating multiple content types.`,
        },
        ...(args.includeImage
          ? [
              {
                type: "image",
                data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
                mimeType: "image/png",
              } as const,
            ]
          : []),
        ...(args.includeResource
          ? ([{ type: "resource_link", uri: "file://config.json" }] as const)
          : []),
      ],
    };
  },
});

const listFilesSchema = z.object({
  path: z.string().default("/"),
  includeHidden: z.boolean().default(false),
  maxResults: z.number().min(1).max(100).default(20),
});

mcp.tool("listFiles", {
  description: "Lists files in a directory (simulated)",
  inputSchema: listFilesSchema,
  handler: (args) => {
    const files = [
      "package.json",
      "README.md",
      "src/",
      "tests/",
      "tsconfig.json",
      ".gitignore",
      "node_modules/",
    ];

    if (args.includeHidden) {
      files.push(".env", ".env.local", ".DS_Store");
    }

    const limited = files.slice(0, args.maxResults);

    return {
      content: [
        {
          type: "text",
          text: `Files in ${args.path}:\n${limited.map((f) => `- ${f}`).join("\n")}`,
        },
      ],
    };
  },
});

const idSchema = z.object({
  type: z.enum(["uuid", "short", "numeric"]).default("uuid"),
  count: z.number().min(1).max(10).default(1),
});

mcp.tool("generateId", {
  description: "Generates various types of IDs",
  inputSchema: idSchema,
  handler: (args) => {
    const ids: string[] = [];

    const count = args.count ?? 1;

    for (let i = 0; i < count; i++) {
      switch (args.type) {
        case "uuid":
          ids.push(crypto.randomUUID());
          break;
        case "short":
          ids.push(Math.random().toString(36).substring(2, 10));
          break;
        case "numeric":
          ids.push(Math.floor(Math.random() * 1000000).toString());
          break;
      }
    }

    return {
      content: [
        {
          type: "text",
          text: ids.join("\n"),
        },
      ],
    };
  },
});

// Registers another tool dynamically when invoked
mcp.tool("enableDynamicTool", {
  description: "Registers a new tool named 'dynamicGreet' on demand",
  handler: () => {
    mcp.tool("dynamicGreet", {
      description: "Greets a user (dynamically added tool)",
      inputSchema: z.object({ name: z.string().default("world") }),
      handler: (args) => ({
        content: [
          {
            type: "text",
            text: `Hello, ${args.name}! (from dynamicGreet)`,
          },
        ],
      }),
    });

    return {
      content: [
        {
          type: "text",
          text: "Dynamic tool 'dynamicGreet' registered",
        },
      ],
    };
  },
});

// ===== ELICITATION EXAMPLES =====

const userConfirmationSchema = z.object({
  action: z.string().min(1, "Action description is required"),
  riskLevel: z.enum(["low", "medium", "high"]).default("medium"),
});

mcp.tool("confirmAction", {
  description:
    "Requests user confirmation before executing an action using elicitation",
  inputSchema: userConfirmationSchema,
  handler: async (args, ctx) => {
    // Check if client supports elicitation
    if (!ctx.client.supports("elicitation")) {
      return {
        content: [
          {
            type: "text",
            text: "❌ Client does not support elicitation. Action cannot be confirmed.",
          },
        ],
      };
    }

    try {
      // Define schema for the confirmation response
      const confirmationSchema = z.object({
        confirmed: z.boolean().describe("Whether to proceed with the action"),
        reason: z
          .string()
          .optional()
          .describe("Optional reason for the decision"),
      });

      // Ask user for confirmation via elicitation
      const result = await ctx.elicit({
        message: `Do you want to proceed with: "${args.action}"?\n\nRisk Level: ${args.riskLevel.toUpperCase()}\n\nPlease confirm whether you want to continue.`,
        schema: confirmationSchema,
      });

      if (result.action === "decline") {
        return {
          content: [
            {
              type: "text",
              text: "❌ User declined to provide confirmation. Action cancelled.",
            },
          ],
        };
      }

      if (result.action === "cancel") {
        return {
          content: [
            {
              type: "text",
              text: "⚠️ User cancelled the confirmation dialog. Action cancelled.",
            },
          ],
        };
      }

      if (result.action === "accept" && result.content) {
        const confirmation = result.content as {
          confirmed: boolean;
          reason?: string;
        };

        if (confirmation.confirmed) {
          return {
            content: [
              {
                type: "text",
                text: `✅ Action confirmed! Proceeding with: "${args.action}"\n${confirmation.reason ? `Reason: ${confirmation.reason}` : ""}`,
              },
            ],
          };
        } else {
          return {
            content: [
              {
                type: "text",
                text: `❌ Action denied. Will not proceed with: "${args.action}"\n${confirmation.reason ? `Reason: ${confirmation.reason}` : ""}`,
              },
            ],
          };
        }
      }

      return {
        content: [
          {
            type: "text",
            text: "⚠️ Unexpected response from user. Action cancelled.",
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `❌ Error during confirmation: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
      };
    }
  },
});

const formDataSchema = z.object({
  formTitle: z.string().default("User Information Form"),
  includeOptional: z.boolean().default(true),
});

mcp.tool("collectFormData", {
  description: "Collects structured form data from user using elicitation",
  inputSchema: formDataSchema,
  handler: async (args, ctx) => {
    if (!ctx.client.supports("elicitation")) {
      return {
        content: [
          {
            type: "text",
            text: "❌ Client does not support elicitation. Cannot collect form data.",
          },
        ],
      };
    }

    try {
      // Create a comprehensive form schema
      const formSchema = z.object({
        name: z.string().min(1, "Name is required"),
        email: z.string().email("Please enter a valid email"),
        age: z.number().min(13).max(120).int("Age must be a whole number"),
        role: z.enum(["developer", "designer", "manager", "other"]),
        experience: args.includeOptional
          ? z.enum(["beginner", "intermediate", "advanced"]).optional()
          : z.enum(["beginner", "intermediate", "advanced"]),
        interests: args.includeOptional
          ? z
              .array(z.string())
              .optional()
              .describe("List of interests (optional)")
          : z.array(z.string()).min(1, "At least one interest is required"),
        newsletter: args.includeOptional
          ? z.boolean().optional().default(false)
          : z.boolean().default(false),
      });

      const message = `${args.formTitle}

Please fill out the following form:

Required fields:
- Name: Your full name
- Email: Valid email address  
- Age: Your age (13-120)
- Role: Your professional role (developer, designer, manager, other)

${
  args.includeOptional
    ? `
Optional fields:
- Experience: Your experience level (beginner, intermediate, advanced)
- Interests: List of your interests
- Newsletter: Whether you want to receive newsletters
`
    : ""
}

Please provide all the requested information.`;

      const result = await ctx.elicit({
        message,
        schema: formSchema,
      });

      if (result.action === "decline") {
        return {
          content: [
            {
              type: "text",
              text: "❌ User declined to fill out the form.",
            },
          ],
        };
      }

      if (result.action === "cancel") {
        return {
          content: [
            {
              type: "text",
              text: "⚠️ User cancelled the form.",
            },
          ],
        };
      }

      if (result.action === "accept" && result.content) {
        const formData = result.content as z.infer<typeof formSchema>;

        return {
          content: [
            {
              type: "text",
              text: `✅ Form submitted successfully!

📝 **${args.formTitle}**

**Personal Information:**
- Name: ${formData.name}
- Email: ${formData.email}
- Age: ${formData.age}

**Professional Information:**
- Role: ${formData.role}
${formData.experience ? `- Experience: ${formData.experience}` : ""}

${formData.interests && formData.interests.length > 0 ? `**Interests:** ${formData.interests.join(", ")}` : ""}
${formData.newsletter !== undefined ? `**Newsletter:** ${formData.newsletter ? "Yes" : "No"}` : ""}

Thank you for providing your information!`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: "⚠️ No form data received.",
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `❌ Error collecting form data: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
      };
    }
  },
});

// ===== RESOURCES =====
mcp.resource(
  "file://config.json",
  {
    name: "Application Configuration",
    description: "Main application configuration file",
    mimeType: "application/json",
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        type: "text",
        text: JSON.stringify(
          {
            name: "comprehensive-mcp-demo",
            version: "2.0.0",
            environment: "development",
            features: ["tools", "resources", "prompts"],
            created: new Date().toISOString(),
          },
          null,
          2,
        ),
        mimeType: "application/json",
      },
    ],
  }),
);

mcp.resource(
  "file://readme.md",
  {
    name: "README Documentation",
    description: "Project documentation and setup instructions",
    mimeType: "text/markdown",
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        type: "text",
        text: `# Comprehensive MCP Demo Server

This server demonstrates all MCP (Model Context Protocol) features including:

## Features
- 🛠️ **Tools**: Various tools with different input/output types
- 📚 **Resources**: Static and template-based resources  
- 💬 **Prompts**: AI conversation templates
- 🔧 **Middleware**: Request processing, logging, and error handling
- 🔄 **Elicitation**: Interactive user input collection and confirmation

## Tools Available
- \`echo\` - Message echoing with repetition
- \`add\` / \`multiply\` - Mathematical operations
- \`getWeather\` - Weather information (mocked)
- \`longRunningOperation\` - Progress demonstration with ctx.progress()
- \`getTinyImage\` - Base64 image generation
- \`annotatedMessage\` - Rich content responses
- \`listFiles\` - File system simulation
- \`generateId\` - ID generation utilities

## Elicitation Tools (Interactive)
- \`confirmAction\` - Request user confirmation before actions
- \`getUserInput\` - Collect typed user input with validation  
- \`collectFormData\` - Gather structured form data from users

## Resources Available
- \`file://config.json\` - Application configuration
- \`file://readme.md\` - This documentation
- \`file://sample.txt\` - Sample text content
- \`file://{path}\` - Dynamic file templates
- \`data://{type}/{id}\` - Data resource templates

## Usage
Connect any MCP-compatible client to this server and explore the available tools, resources, and prompts.
`,
        mimeType: "text/markdown",
      },
    ],
  }),
);

mcp.resource(
  "file://sample.txt",
  {
    name: "Sample Text File",
    description: "A sample text file for demonstration",
    mimeType: "text/plain",
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        type: "text",
        text: `This is a sample text file created at ${new Date().toISOString()}.

It contains some example content to demonstrate resource reading capabilities.

Features demonstrated:
- Static resource serving
- MIME type specification
- Timestamped content generation
- Multi-line text content

You can use this resource in prompts or reference it from tools.`,
        mimeType: "text/plain",
      },
    ],
  }),
);

mcp.resource(
  "file://{path}",
  {
    name: "Dynamic File Resource",
    description: "Access files by path",
    mimeType: "text/plain",
  },
  { path: z.string().regex(/^[a-zA-Z0-9/_.-]+$/) },
  async (uri, { path }) => {
    const extension = path?.split(".").pop() || "";
    let mimeType = "text/plain";
    let content = `Content of file: ${path}`;

    switch (extension) {
      case "json":
        mimeType = "application/json";
        content = JSON.stringify(
          { file: path, accessed: new Date().toISOString() },
          null,
          2,
        );
        break;
      case "md":
        mimeType = "text/markdown";
        content = `# ${path}\n\nThis is a markdown file at path: ${path}`;
        break;
      case "js":
      case "ts":
        mimeType = "text/javascript";
        content = `// File: ${path}\nconsole.log("Hello from ${path}");`;
        break;
      default:
        content = `This is the content of ${path}.\nGenerated at: ${new Date().toISOString()}`;
    }

    return {
      contents: [
        {
          uri: uri.href,
          type: "text",
          text: content,
          mimeType,
        },
      ],
    };
  },
);

mcp.resource(
  "data://{type}/{id}",
  {
    name: "Data Resource",
    description: "Access structured data by type and ID",
    mimeType: "application/json",
  },
  {
    type: z.enum(["user", "post", "comment", "product"]),
    id: z.string().regex(/^\d+$/),
  },
  async (uri, { type, id }) => {
    let data: Record<string, unknown> = {};

    switch (type) {
      case "user":
        data = {
          id: Number(id),
          name: `User ${id}`,
          email: `user${id}@example.com`,
          created: new Date(Date.now() - Number(id) * 86400000).toISOString(),
        };
        break;
      case "post":
        data = {
          id: Number(id),
          title: `Post ${id}`,
          content: `This is the content of post ${id}. Lorem ipsum dolor sit amet.`,
          authorId: Math.floor(Math.random() * 100) + 1,
          created: new Date(Date.now() - Number(id) * 3600000).toISOString(),
        };
        break;
      case "comment":
        data = {
          id: Number(id),
          text: `This is comment ${id}`,
          postId: Math.floor(Math.random() * 50) + 1,
          authorId: Math.floor(Math.random() * 100) + 1,
          created: new Date(Date.now() - Number(id) * 1800000).toISOString(),
        };
        break;
      case "product":
        data = {
          id: Number(id),
          name: `Product ${id}`,
          price: Number((Math.random() * 100).toFixed(2)),
          category: ["electronics", "books", "clothing", "home"][
            Math.floor(Math.random() * 4)
          ],
          inStock: Math.random() > 0.3,
        };
        break;
    }

    return {
      contents: [
        {
          uri: uri.href,
          type: "text",
          text: JSON.stringify(data, null, 2),
          mimeType: "application/json",
        },
      ],
    };
  },
);

// ===== PROMPTS =====
const codeReviewSchema = z.object({
  code: z.string().min(1, "Code is required"),
  language: z.string().default("typescript"),
  strictness: z.enum(["low", "medium", "high"]).default("medium"),
});

mcp.prompt("codeReview", {
  description: "Generate a code review prompt with configurable strictness",
  arguments: [
    { name: "code", description: "The code to review", required: true },
    { name: "language", description: "Programming language", required: false },
    {
      name: "strictness",
      description: "Review strictness level",
      required: false,
    },
  ],
  inputSchema: codeReviewSchema,
  handler: (args: z.infer<typeof codeReviewSchema>) => {
    const strictnessPrompts = {
      low: "Please provide a gentle code review focusing on major issues only.",
      medium:
        "Please provide a balanced code review covering functionality, style, and best practices.",
      high: "Please provide a thorough code review examining all aspects including security, performance, maintainability, and adherence to best practices.",
    };

    return {
      description: `Code review for ${args.language} code with ${args.strictness} strictness`,
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text",
            text: `${strictnessPrompts[args.strictness]}

Programming Language: ${args.language}

Code to review:
\`\`\`${args.language}
${args.code}
\`\`\`

Please structure your review with:
1. Overall assessment
2. Specific issues (if any)
3. Suggestions for improvement
4. Positive aspects`,
          },
        },
      ],
    };
  },
});

const explainSchema = z.object({
  concept: z.string().min(1, "Concept is required"),
  audience: z
    .enum(["beginner", "intermediate", "advanced"])
    .default("intermediate"),
  includeExamples: z.boolean().default(true),
});

mcp.prompt("explainConcept", {
  description: "Generate an educational explanation for any concept",
  arguments: [
    { name: "concept", description: "The concept to explain", required: true },
    { name: "audience", description: "Target audience level", required: false },
    {
      name: "includeExamples",
      description: "Include practical examples",
      required: false,
    },
  ],
  inputSchema: explainSchema,
  handler: (args: z.infer<typeof explainSchema>) => {
    const audienceInstructions = {
      beginner:
        "Explain this concept in simple terms, avoiding jargon where possible. Use analogies and step-by-step explanations.",
      intermediate:
        "Provide a clear explanation with some technical detail. Assume basic background knowledge.",
      advanced:
        "Give a comprehensive explanation with technical depth, including edge cases and advanced considerations.",
    };

    return {
      description: `Educational explanation of ${args.concept} for ${args.audience} level`,
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text",
            text: `Please explain the concept: "${args.concept}"

Target audience: ${args.audience} level
${audienceInstructions[args.audience]}

${args.includeExamples ? "Please include practical examples and use cases." : "Focus on theoretical explanation without examples."}

Structure your explanation with:
1. Clear definition
2. Key principles or components
3. ${args.includeExamples ? "Practical examples" : "Important considerations"}
4. Common misconceptions (if applicable)
5. Further learning resources`,
          },
        },
      ],
    };
  },
});

const docSchema = z.object({
  code: z.string().min(1, "Code is required"),
  style: z.enum(["api", "tutorial", "reference", "readme"]).default("api"),
  includeExamples: z.boolean().default(true),
});

mcp.prompt("generateDocumentation", {
  description: "Generate documentation from code",
  arguments: [
    { name: "code", description: "Source code to document", required: true },
    { name: "style", description: "Documentation style", required: false },
    {
      name: "includeExamples",
      description: "Include usage examples",
      required: false,
    },
  ],
  inputSchema: docSchema,
  handler: (args: z.infer<typeof docSchema>) => {
    const styleInstructions = {
      api: "Generate API documentation with clear method signatures, parameters, return values, and usage notes.",
      tutorial:
        "Create tutorial-style documentation that guides users through using this code step by step.",
      reference:
        "Produce comprehensive reference documentation with all details, edge cases, and technical specifications.",
      readme:
        "Write README-style documentation that introduces the code and explains how to get started.",
    };

    return {
      description: `${args.style} documentation generation`,
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text",
            text: `Please generate ${args.style} documentation for the following code:

\`\`\`
${args.code}
\`\`\`

Style: ${args.style}
${styleInstructions[args.style]}

${args.includeExamples ? "Include practical usage examples and code snippets." : "Focus on describing functionality without examples."}

Please use clear markdown formatting and organize the documentation logically.`,
          },
        },
      ],
    };
  },
});

const summarySchema = z.object({
  content: z.string().min(1, "Content is required"),
  length: z.enum(["brief", "medium", "detailed"]).default("medium"),
  focus: z.string().optional(),
});

mcp.prompt("summarizeContent", {
  description: "Summarize content with configurable length and focus",
  arguments: [
    { name: "content", description: "Content to summarize", required: true },
    { name: "length", description: "Summary length", required: false },
    { name: "focus", description: "Specific focus area", required: false },
  ],
  inputSchema: summarySchema,
  handler: (args: z.infer<typeof summarySchema>) => {
    const lengthInstructions = {
      brief:
        "Provide a concise summary in 1-2 sentences focusing on the main point.",
      medium:
        "Create a balanced summary in 2-3 paragraphs covering key points and important details.",
      detailed:
        "Generate a comprehensive summary that covers all major topics, supporting details, and implications.",
    };

    const messages: Array<{
      role: "user" | "assistant" | "system";
      content: {
        type: "text" | "image" | "resource";
        text?: string;
        data?: string;
        mimeType?: string;
      };
    }> = [
      {
        role: "user",
        content: {
          type: "text",
          text: `Please summarize the following content:

Length: ${args.length}
${lengthInstructions[args.length]}

${args.focus ? `Special focus: Pay particular attention to aspects related to "${args.focus}".` : ""}

Content to summarize:
---
${args.content}
---

Please structure your summary clearly and highlight the most important insights.`,
        },
      },
    ];

    messages.push({
      role: "user",
      content: {
        type: "resource",
        text: "file://config.json",
      },
    });

    return {
      description: `${args.length} summary${args.focus ? ` focused on ${args.focus}` : ""}`,
      messages,
    };
  },
});

// ===== ERROR HANDLER =====

mcp.onError((error, ctx) => {
  console.error(`Error in ${ctx.request.method}:`, error);
  if (error instanceof z.ZodError) {
    return {
      code: -32602, // Invalid params
      message: "Input validation failed",
      data: {
        issues: error.issues,
        requestId: ctx.requestId,
      },
    };
  }

  if (error instanceof Error && error.message.includes("Rate limit")) {
    return {
      code: -32000, // Custom application error
      message: "Rate limit exceeded",
      data: {
        retryAfter: 60,
        requestId: ctx.requestId,
      },
    };
  }

  return undefined;
});

// ===== HTTP TRANSPORT SETUP =====

// This server requires a session adapter to support sessions and the GET /mcp SSE stream
// Also includes a client request adapter to support elicitation (bidirectional communication)
const transport = new StreamableHttpTransport({
  sessionAdapter: new InMemorySessionAdapter({ maxEventBufferSize: 1024 }),
  clientRequestAdapter: new InMemoryClientRequestAdapter(),
});
const httpHandler = transport.bind(mcp);

const app = new Hono();

app.use(cors());

app.all("/mcp", async (c) => {
  const response = await httpHandler(c.req.raw);
  return response;
});

app.get("/health", (c) => {
  return c.json({
    status: "healthy",
    server: "comprehensive-mcp-demo",
    version: "2.0.0",
    timestamp: new Date().toISOString(),
    capabilities: {
      tools: true,
      resources: true,
      prompts: true,
      middleware: true,
      elicitation: true,
    },
    endpoints: {
      mcp: "/mcp",
      health: "/health",
      info: "/info",
    },
  });
});

app.get("/info", (c) => {
  return c.json({
    name: "comprehensive-mcp-demo",
    version: "2.0.0",
    description:
      "A comprehensive MCP server demonstrating all protocol features",
    features: {
      tools: [
        "echo",
        "add",
        "multiply",
        "longRunningOperation",
        "getWeather",
        "getTinyImage",
        "annotatedMessage",
        "listFiles",
        "generateId",
        "confirmAction",
        "getUserInput",
        "collectFormData",
      ],
      resources: [
        "file://config.json",
        "file://readme.md",
        "file://sample.txt",
        "file://{path}",
        "data://{type}/{id}",
      ],
      prompts: [
        "codeReview",
        "explainConcept",
        "generateDocumentation",
        "summarizeContent",
      ],
      middleware: [
        "logging",
        "error-handling",
        "rate-limiting",
        "authentication",
      ],
    },
    documentation: "See file://readme.md resource for detailed information",
  });
});

const port = 3002;

export default app;

if (import.meta.main) {
  console.log("🚀 Starting Comprehensive MCP Demo Server...");
  console.log(`📍 Port: ${port}`);
  console.log(`🔗 Health check: http://localhost:${port}/health`);
  console.log(`📊 Server info: http://localhost:${port}/info`);
  console.log(`🔌 MCP endpoint: http://localhost:${port}/mcp`);
  console.log("");
  console.log("📚 Available Tools:");
  console.log("  • echo - Message echoing with repetition");
  console.log("  • add - Mathematical addition");
  console.log("  • multiply - Mathematical multiplication");
  console.log(
    "  • longRunningOperation - Progress demonstration with ctx.progress()",
  );
  console.log("  • getWeather - Weather information (mocked)");
  console.log("  • getTinyImage - Base64 image generation");
  console.log("  • annotatedMessage - Rich content responses");
  console.log("  • listFiles - File system simulation");
  console.log("  • generateId - ID generation utilities");
  console.log("");
  console.log("🔄 Elicitation Tools (Interactive):");
  console.log("  • confirmAction - User confirmation via elicitation");
  console.log("  • getUserInput - Collect user input with validation");
  console.log("  • collectFormData - Structured form data collection");
  console.log("");
  console.log("📄 Available Resources:");
  console.log("  • file://config.json - Application configuration");
  console.log("  • file://readme.md - Documentation");
  console.log("  • file://sample.txt - Sample text content");
  console.log("  • file://{path} - Dynamic file templates");
  console.log("  • data://{type}/{id} - Data resource templates");
  console.log("");
  console.log("💬 Available Prompts:");
  console.log("  • codeReview - Code review generation");
  console.log("  • explainConcept - Educational explanations");
  console.log("  • generateDocumentation - Documentation generation");
  console.log("  • summarizeContent - Content summarization");
  console.log("");

  Bun.serve({
    port,
    fetch: app.fetch,
  });
}
