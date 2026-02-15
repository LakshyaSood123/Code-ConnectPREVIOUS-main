import React, { useState, useCallback, useEffect } from 'react';
import type { ToolType, AnalysisResult, KpiStats } from '@shared/schema';

const API_BASE_URL = "https://371kvaeiy5.execute-api.ap-south-1.amazonaws.com/prod";
const ANALYZE_BUCKET = "doc-risk-demo-reagvis";
const DEMO_MIN_DELAY_MS = 800;

// Mock types for our simulation
type AnalysisRequest = {
  filename?: string;
  content?: string;
  toolType: ToolType;
  file?: File;
  claimedLocation?: string;
  claimedEvent?: string;
};

// Initial KPI stats
const INITIAL_STATS: KpiStats = {
  total: 124,
  rejected: 12,
  manual: 5,
  approved: 107
};

const wordBoundaryRegex = (word: string) => new RegExp(`(^|[^a-z0-9])${word}([^a-z0-9]|$)`, 'i');

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const mapRiskScore = (riskScore: number) => {
  if (riskScore >= 61) {
    return { priority: "CRITICAL", decision: "REJECT" };
  }
  if (riskScore >= 31) {
    return { priority: "MEDIUM", decision: "MANUAL_REVIEW" };
  }
  return { priority: "LOW", decision: "APPROVE" };
};

const buildPreviewUrl = (file?: File) => {
  if (file && file.type.startsWith('image/')) {
    return URL.createObjectURL(file);
  }
  return null;
};

const getDemoOverride = (req: AnalysisRequest) => {
  const source = `${req.filename || ""} ${req.content || ""}`.trim();
  if (!source) return null;

  if (wordBoundaryRegex("fake").test(source)) {
    return {
      riskScore: 92,
      evidence: ["Demo override: filename/content contains the word \"fake\"."]
    };
  }
  if (wordBoundaryRegex("real").test(source)) {
    return {
      riskScore: 8,
      evidence: ["Demo override: filename/content contains the word \"real\"."]
    };
  }
  return null;
};

type BackendUploadInfo = {
  upload_url: string;
  key: string;
};

type StageError = Error & { stage?: "upload-url" | "s3-upload" | "analyze" };

const makeStageError = (stage: "upload-url" | "s3-upload" | "analyze", message: string) => {
  const error = new Error(message) as StageError;
  error.stage = stage;
  return error;
};

const requestUploadUrl = async (): Promise<BackendUploadInfo> => {
  const response = await fetch(`${API_BASE_URL}/get-upload-url`, {
    method: "POST"
  });

  if (!response.ok) {
    throw makeStageError("upload-url", "Failed to request upload URL");
  }

  const data = await response.json();
  if (!data?.upload_url || !data?.key) {
    throw makeStageError("upload-url", "Invalid upload URL response");
  }

  return data;
};

const uploadToS3 = async (uploadUrl: string, file: File) => {
  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": file.type || "application/octet-stream"
    },
    body: file
  });

  if (!response.ok) {
    throw makeStageError("s3-upload", "Failed to upload to S3");
  }
};

const analyzeUploadedFile = async (key: string): Promise<number> => {
  const response = await fetch(`${API_BASE_URL}/analyze`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      bucket: ANALYZE_BUCKET,
      key
    })
  });

  if (!response.ok) {
    throw makeStageError("analyze", "Failed to analyze uploaded file");
  }

  const data = await response.json();
  if (typeof data?.risk_score !== "number") {
    throw makeStageError("analyze", "Invalid analysis response");
  }

  return data.risk_score;
};

const buildBackendResult = (req: AnalysisRequest, riskScore: number, evidence: string[]): AnalysisResult => {
  const { priority, decision } = mapRiskScore(riskScore);
  const previewUrl = buildPreviewUrl(req.file);

  return {
    id: Math.floor(Math.random() * 100000),
    filename: req.filename || `document_${Date.now()}.png`,
    toolType: req.toolType,
    riskScore,
    priority,
    decision,
    evidence,
    actionRequired: decision === "MANUAL_REVIEW" ? "Analyst verification needed" : null,
    timestamp: new Date(),
    previewUrl,
    metadata: null,
    geolocation: null,
    verification: null,
  };
};

const applyDemoOverride = (result: AnalysisResult, override: { riskScore: number; evidence: string[] }) => {
  const { priority, decision } = mapRiskScore(override.riskScore);
  return {
    ...result,
    riskScore: override.riskScore,
    priority,
    decision,
    evidence: [...override.evidence, ...result.evidence],
    actionRequired: decision === "MANUAL_REVIEW" ? "Analyst verification needed" : null,
  };
};

// Helper to generate mock results based on deterministic rules
function generateMockResult(req: AnalysisRequest): AnalysisResult {
  const isFake = (req.filename || req.content || "").toLowerCase().includes("_fake");
  const isReal = (req.filename || req.content || "").toLowerCase().includes("_real");
  
  let previewUrl: string | null = null;
  if (req.file && req.file.type.startsWith('image/')) {
    previewUrl = URL.createObjectURL(req.file);
  }

  // Default to uncertain/manual review unless specified
  let riskScore = Math.floor(Math.random() * 20) + 40; // 40-60
  let priority = "MEDIUM";
  let decision = "MANUAL_REVIEW";
  let evidence: string[] = ["Inconclusive patterns", "Standard encoding detected"];
  let metadata: any = null;
  let geolocation: any = null;
  const filenameLower = (req.filename || "").toLowerCase();

  if (req.toolType === 'verification') {
    // Location prediction based on filename triggers
    let predictedLocation = "Unknown";
    let predictedEvent = "Unknown";
    let locationConfidence = 0.35;
    let locationReasons: string[] = ["Insufficient cues for reliable verification (demo)"];
    
    if (filenameLower.includes("eiffel") || filenameLower.includes("paris") || filenameLower.includes("31001")) {
      predictedLocation = "Paris, France";
      predictedEvent = "landmark photo";
      locationConfidence = 0.94;
      locationReasons = ["Landmark match: Eiffel Tower silhouette", "Urban skyline consistent with Paris"];
    } else if (filenameLower.includes("quake_turkey") || filenameLower.includes("turkey_32001") || filenameLower.includes("32001")) {
      predictedLocation = "Kahramanmaras, Turkey";
      predictedEvent = "earthquake";
      locationConfidence = 0.88;
      locationReasons = ["Reference match: earthquake scene (demo)", "Context cues consistent with quake aftermath (demo)"];
    } else if (filenameLower.includes("flood_kanchipuram") || filenameLower.includes("kanchipuram") || filenameLower.includes("tamilnadu") || filenameLower.includes("33001")) {
      predictedLocation = "Kanchipuram District, Tamil Nadu, India";
      predictedEvent = "flood";
      locationConfidence = 0.90;
      locationReasons = ["Reference match: flood aerial inundation (demo)", "Urban inundation context consistent with district flooding (demo)"];
    }

    // Compare claimed vs predicted
    const claimedLocation = (req.claimedLocation || "").toLowerCase().trim().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ');
    const claimedEvent = req.claimedEvent || "";
    const predictedNormalized = predictedLocation.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ');
    
    let matchStatus: "match" | "mismatch" | "insufficient" = "insufficient";
    let locationMessage = "";
    
    if (predictedLocation === "Unknown") {
      riskScore = 55;
      priority = "MEDIUM";
      decision = "MANUAL_REVIEW";
      matchStatus = "insufficient";
      locationMessage = "Cannot confirm location; insufficient cues.";
    } else if (!claimedLocation) {
      riskScore = 50;
      priority = "MEDIUM";
      decision = "MANUAL_REVIEW";
      matchStatus = "insufficient";
      locationMessage = "Provide a claimed location to verify.";
    } else {
      // Check if claimed contains predicted country or key city
      const predictedParts = predictedNormalized.split(' ');
      const hasMatch = predictedParts.some(part => part.length > 2 && claimedLocation.includes(part));
      
      if (hasMatch) {
        riskScore = 12;
        priority = "LOW";
        decision = "APPROVE";
        matchStatus = "match";
        locationMessage = "Claim consistent with predicted location.";
      } else {
        riskScore = 85;
        priority = "CRITICAL";
        decision = "REJECT";
        matchStatus = "mismatch";
        locationMessage = "Claim mismatch: Not consistent with predicted location.";
      }
    }

    // Build verification data for export
    const verificationData = {
      claimedLocation: req.claimedLocation || "",
      claimedEvent: claimedEvent,
      predictedLocation,
      predictedEvent,
      confidence: locationConfidence,
      matchStatus,
      reasons: [...locationReasons, locationMessage]
    };

    // Section A: Metadata Analysis (keep existing but simplified)
    let metaDecision = "MANUAL_REVIEW";
    let metaEvidence = ["Analysis required"];
    
    if (isFake) {
      metaDecision = "REJECT";
      metaEvidence = [
        "Edited software footprint (Adobe Photoshop)",
        "EXIF timestamp mismatch",
        "Anomalous header structures"
      ];
    } else if (isReal) {
      metaDecision = "APPROVE";
      metaEvidence = [
        "Clean metadata profile",
        "Consistent device fingerprints",
        "No software traces found"
      ];
    } else {
      metaEvidence = ["Standard metadata patterns", "Partial review suggested"];
    }
    metadata = { decision: metaDecision, evidence: metaEvidence };

    // Section B: Geolocation Verification
    let geoDecision = matchStatus === "match" ? "APPROVE" : matchStatus === "mismatch" ? "REJECT" : "MANUAL_REVIEW";
    let geoEvidence = [locationMessage, ...locationReasons];
    geolocation = { decision: geoDecision, evidence: geoEvidence };

    evidence = ["Combined verification complete. See sections for details."];

    return {
      id: Math.floor(Math.random() * 100000),
      filename: req.filename || `verification_${Date.now()}.txt`,
      toolType: req.toolType,
      riskScore,
      priority,
      decision,
      evidence,
      actionRequired: decision === "MANUAL_REVIEW" ? "Analyst verification needed" : null,
      timestamp: new Date(),
      previewUrl,
      metadata,
      geolocation,
      verification: verificationData,
    };

  } else {
    // Existing logic for document tool
    if (isFake) {
      riskScore = Math.floor(Math.random() * 10) + 88; // 88-98
      priority = "CRITICAL";
      decision = "REJECT";
      evidence = [
        "High probability of digital manipulation",
        "Inconsistent error level analysis (ELA)",
        "Metadata anomalies detected in header"
      ];
    } else if (isReal) {
      riskScore = Math.floor(Math.random() * 10) + 2; // 2-12
      priority = "LOW";
      decision = "APPROVE";
      evidence = [
        "Verified digital signature present",
        "Consistent sensor pattern noise",
        "No manipulation traces found"
      ];
    }
  }

  return {
    id: Math.floor(Math.random() * 100000),
    filename: req.filename || `text_analysis_${Date.now()}.txt`,
    toolType: req.toolType,
    riskScore,
    priority,
    decision,
    evidence,
    actionRequired: decision === "MANUAL_REVIEW" ? "Analyst verification needed" : null,
    timestamp: new Date(),
    previewUrl,
    metadata,
    geolocation,
    verification: null,
  };
}

export function useAnalysisSimulation() {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [results, setResults] = useState<AnalysisResult[]>([]);
  const [stats, setStats] = useState<KpiStats>(INITIAL_STATS);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Revoke object URLs on unmount to prevent leaks
  useEffect(() => {
    return () => {
      results.forEach(r => {
        if (r.previewUrl) URL.revokeObjectURL(r.previewUrl);
      });
    };
  }, [results]);

  const runAnalysis = useCallback(async (req: AnalysisRequest) => {
    setIsAnalyzing(true);
    setToastMessage("Uploading and processing...");

    const startTime = Date.now();
    const isImageUpload = !!req.file && req.file.type.startsWith('image/');
    const useBackend = req.toolType === 'document' && isImageUpload;
    const demoOverride = getDemoOverride(req);

    try {
      let newResult: AnalysisResult;

      if (useBackend && req.file) {
        if (demoOverride) {
          const evidence = demoOverride.evidence;
          newResult = buildBackendResult(req, demoOverride.riskScore, evidence);
        } else {
          setToastMessage("Requesting secure upload...");
          const uploadInfo = await requestUploadUrl();

          setToastMessage("Uploading to secure storage...");
          try {
            await uploadToS3(uploadInfo.upload_url, req.file);
          } catch (error) {
            // Retry once on S3 upload failure
            await uploadToS3(uploadInfo.upload_url, req.file);
          }

          setToastMessage("Analyzing document integrity...");
          const riskScore = await analyzeUploadedFile(uploadInfo.key);

          newResult = buildBackendResult(req, riskScore, [
            "Risk score generated by Bedrock document integrity model.",
            `S3 key: ${uploadInfo.key}`
          ]);
        }
      } else {
        // Simulate network latency (1.5s) for non-backend flows
        await sleep(1500);
        newResult = generateMockResult(req);
        if (demoOverride) {
          newResult = applyDemoOverride(newResult, demoOverride);
        }
      }

      const elapsed = Date.now() - startTime;
      if (elapsed < DEMO_MIN_DELAY_MS) {
        await sleep(DEMO_MIN_DELAY_MS - elapsed);
      }

      setResults(prev => [newResult, ...prev]);
      setIsAnalyzing(false);
      setToastMessage("Analysis complete");

      // Auto-update stats based on the result
      setStats(prev => ({
        ...prev,
        total: prev.total + 1,
        approved: newResult.decision === "APPROVE" ? prev.approved + 1 : prev.approved,
        rejected: newResult.decision === "REJECT" ? prev.rejected + 1 : prev.rejected,
        manual: newResult.decision === "MANUAL_REVIEW" ? prev.manual + 1 : prev.manual,
      }));

      // Clear toast after 3s
      setTimeout(() => setToastMessage(null), 3000);

      return newResult;
    } catch (error) {
      const stage = (error as StageError)?.stage;
      if (stage === "upload-url") {
        setToastMessage("Upload service temporarily unavailable");
      } else if (stage === "s3-upload") {
        setToastMessage("Upload failed. Please retry.");
      } else {
        setToastMessage("Analysis failed. Please retry.");
      }
      setIsAnalyzing(false);
      setTimeout(() => setToastMessage(null), 3000);
      return null;
    }
  }, []);

  const updateDecision = useCallback((id: number, decision: "APPROVE" | "REJECT" | "MANUAL_REVIEW") => {
    setResults(prev => prev.map(r => {
      if (r.id === id && r.decision !== decision) {
        // Adjust stats if changing decision
        setStats(curr => {
          const newStats = { ...curr };
          // Decrement old category
          if (r.decision === "APPROVE") newStats.approved--;
          else if (r.decision === "REJECT") newStats.rejected--;
          else if (r.decision === "MANUAL_REVIEW") newStats.manual--;
          
          // Increment new category
          if (decision === "APPROVE") newStats.approved++;
          else if (decision === "REJECT") newStats.rejected++;
          else if (decision === "MANUAL_REVIEW") newStats.manual++;
          
          return newStats;
        });
        
        return { ...r, decision, actionRequired: null };
      }
      return r;
    }));
  }, []);

  return {
    isAnalyzing,
    results,
    stats,
    toastMessage,
    runAnalysis,
    updateDecision
  };
}
