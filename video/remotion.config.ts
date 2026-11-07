import { Config } from "@remotion/cli/config";

// JPEG frames keep Studio, draft and 4K renders fast.
Config.setVideoImageFormat("jpeg");
Config.setJpegQuality(95);
Config.setOverwriteOutput(true);
