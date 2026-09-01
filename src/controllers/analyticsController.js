import mongoose from "mongoose";
import FollowUp from "../models/FollowUp.js";
import Project from "../models/Project.js";
import User from "../models/User.js";

export const getDashboardSummary = async (req, res) => {
  try {
    const { startDate, endDate, user, project } = req.query;

    const matchQuery = { status: { $in: ["submitted", "reviewed"] }, type: "evening", "evening.projects": { $exists: true, $not: { $size: 0 } } };

    if (startDate && endDate) {
      matchQuery.date = { $gte: startDate, $lte: endDate };
    } else if (startDate) {
      matchQuery.date = { $gte: startDate };
    } else if (endDate) {
      matchQuery.date = { $lte: endDate };
    }

    if (user) {
      matchQuery.user = new mongoose.Types.ObjectId(user);
    }

    // 1. Total Projects
    const totalProjects = await Project.countDocuments({ status: { $ne: "archived" } }); // active projects

    // 2. Dashboard Aggregation for Active Users, Total Hours, Most Active Project, Most Active User
    const aggregatedData = await FollowUp.aggregate([
      { $match: matchQuery },
      { $unwind: "$evening.projects" },
      {
        $group: {
          _id: null,
          users: { $addToSet: "$user" },
          totalMinutes: { $sum: "$evening.projects.totalMinutes" },
          projectMinutes: { $push: { project: "$evening.projects.project", minutes: "$evening.projects.totalMinutes", user: "$user" } }
        }
      }
    ]);

    if (!aggregatedData || aggregatedData.length === 0) {
      return res.json({
        success: true,
        data: {
          totalProjects,
          totalActiveUsers: 0,
          totalWorkingHours: 0,
          mostActiveProject: null,
          mostActiveUser: null
        }
      });
    }

    const { users, totalMinutes, projectMinutes } = aggregatedData[0];
    const totalActiveUsers = users.length;
    const totalWorkingHours = Math.floor(totalMinutes / 60);

    // Group by project
    const projectStats = {};
    const userStats = {};

    projectMinutes.forEach(pm => {
      const pId = pm.project?.toString();
      const uId = pm.user?.toString();
      if (pId) {
        projectStats[pId] = (projectStats[pId] || 0) + pm.minutes;
      }
      if (uId) {
        userStats[uId] = (userStats[uId] || 0) + pm.minutes;
      }
    });

    let mostActiveProjectId = null;
    let maxProjectMins = 0;
    for (const [id, mins] of Object.entries(projectStats)) {
      if (mins > maxProjectMins) {
        maxProjectMins = mins;
        mostActiveProjectId = id;
      }
    }

    let mostActiveUserId = null;
    let maxUserMins = 0;
    for (const [id, mins] of Object.entries(userStats)) {
      if (mins > maxUserMins) {
        maxUserMins = mins;
        mostActiveUserId = id;
      }
    }

    let mostActiveProject = null;
    if (mostActiveProjectId) {
      const p = await Project.findById(mostActiveProjectId).select("name");
      if (p) {
        mostActiveProject = { name: p.name, hours: Math.floor(maxProjectMins / 60) };
      }
    }

    let mostActiveUser = null;
    if (mostActiveUserId) {
      const u = await User.findById(mostActiveUserId).select("name");
      if (u) {
        mostActiveUser = { name: u.name, hours: Math.floor(maxUserMins / 60) };
      }
    }

    res.json({
      success: true,
      data: {
        totalProjects,
        totalActiveUsers,
        totalWorkingHours,
        mostActiveProject,
        mostActiveUser
      }
    });

  } catch (error) {
    console.error("Error in getDashboardSummary:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

export const getProjectAnalytics = async (req, res) => {
  try {
    const { startDate, endDate, user, project, minHours, maxHours, sort = "timeDesc", page = 1, limit = 10 } = req.query;

    const matchQuery = { status: { $in: ["submitted", "reviewed"] }, type: "evening", "evening.projects": { $exists: true, $not: { $size: 0 } } };

    if (startDate && endDate) {
      matchQuery.date = { $gte: startDate, $lte: endDate };
    } else if (startDate) {
      matchQuery.date = { $gte: startDate };
    } else if (endDate) {
      matchQuery.date = { $lte: endDate };
    }
    if (user) {
      matchQuery.user = new mongoose.Types.ObjectId(user);
    }

    const aggregationPipeline = [
      { $match: matchQuery },
      { $unwind: "$evening.projects" }
    ];

    if (project) {
      aggregationPipeline.push({ $match: { "evening.projects.project": new mongoose.Types.ObjectId(project) } });
    }

    aggregationPipeline.push(
      {
        $group: {
          _id: "$evening.projects.project",
          totalMinutes: { $sum: "$evening.projects.totalMinutes" },
          uniqueUsers: { $addToSet: "$user" }
        }
      },
      {
        $lookup: {
          from: "projects",
          localField: "_id",
          foreignField: "_id",
          as: "projectDetails"
        }
      },
      { $unwind: "$projectDetails" },
      {
        $project: {
          projectId: "$_id",
          projectName: "$projectDetails.name",
          projectDescription: "$projectDetails.description",
          totalMinutes: 1,
          totalUsers: { $size: "$uniqueUsers" }
        }
      }
    );

    if (minHours) {
      aggregationPipeline.push({ $match: { totalMinutes: { $gte: Number(minHours) * 60 } } });
    }
    if (maxHours) {
      aggregationPipeline.push({ $match: { totalMinutes: { $lte: Number(maxHours) * 60 } } });
    }

    let sortObj = { totalMinutes: -1 }; // timeDesc
    if (sort === "timeAsc") sortObj = { totalMinutes: 1 };
    else if (sort === "nameAsc") sortObj = { projectName: 1 };
    else if (sort === "nameDesc") sortObj = { projectName: -1 };

    aggregationPipeline.push({ $sort: sortObj });

    const results = await FollowUp.aggregate(aggregationPipeline);

    const total = results.length;
    const totalPages = Math.ceil(total / Number(limit));
    const paginatedResults = results.slice((Number(page) - 1) * Number(limit), Number(page) * Number(limit));

    res.json({
      success: true,
      data: {
        projects: paginatedResults,
        pagination: {
          total,
          page: Number(page),
          totalPages,
          limit: Number(limit)
        }
      }
    });

  } catch (error) {
    console.error("Error in getProjectAnalytics:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

export const getUserAnalytics = async (req, res) => {
  try {
    const { startDate, endDate, user, project, minHours, maxHours, sort = "timeDesc", page = 1, limit = 10 } = req.query;

    const matchQuery = { status: { $in: ["submitted", "reviewed"] }, type: "evening", "evening.projects": { $exists: true, $not: { $size: 0 } } };

    if (startDate && endDate) {
      matchQuery.date = { $gte: startDate, $lte: endDate };
    } else if (startDate) {
      matchQuery.date = { $gte: startDate };
    } else if (endDate) {
      matchQuery.date = { $lte: endDate };
    }

    // Filter by a specific user — mirrors the same pattern in getProjectAnalytics.
    if (user) {
      matchQuery.user = new mongoose.Types.ObjectId(user);
    }

    const aggregationPipeline = [
      { $match: matchQuery },
      { $unwind: "$evening.projects" }
    ];

    if (project) {
      aggregationPipeline.push({ $match: { "evening.projects.project": new mongoose.Types.ObjectId(project) } });
    }

    aggregationPipeline.push(
      {
        $group: {
          _id: "$user",
          totalMinutes: { $sum: "$evening.projects.totalMinutes" },
          uniqueProjects: { $addToSet: "$evening.projects.project" }
        }
      },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "userDetails"
        }
      },
      { $unwind: "$userDetails" },
      {
        $project: {
          userId: "$_id",
          userName: "$userDetails.name",
          totalMinutes: 1,
          totalProjects: { $size: "$uniqueProjects" }
        }
      }
    );

    if (minHours) {
      aggregationPipeline.push({ $match: { totalMinutes: { $gte: Number(minHours) * 60 } } });
    }
    if (maxHours) {
      aggregationPipeline.push({ $match: { totalMinutes: { $lte: Number(maxHours) * 60 } } });
    }

    let sortObj = { totalMinutes: -1 }; // timeDesc
    if (sort === "timeAsc") sortObj = { totalMinutes: 1 };
    else if (sort === "nameAsc") sortObj = { userName: 1 };
    else if (sort === "nameDesc") sortObj = { userName: -1 };

    aggregationPipeline.push({ $sort: sortObj });

    const results = await FollowUp.aggregate(aggregationPipeline);

    const total = results.length;
    const totalPages = Math.ceil(total / Number(limit));
    const paginatedResults = results.slice((Number(page) - 1) * Number(limit), Number(page) * Number(limit));

    res.json({
      success: true,
      data: {
        users: paginatedResults,
        pagination: {
          total,
          page: Number(page),
          totalPages,
          limit: Number(limit)
        }
      }
    });

  } catch (error) {
    console.error("Error in getUserAnalytics:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

export const getProjectDetails = async (req, res) => {
  try {
    const { id } = req.params;
    const { startDate, endDate } = req.query;

    const matchQuery = { status: { $in: ["submitted", "reviewed"] }, type: "evening", "evening.projects.project": new mongoose.Types.ObjectId(id) };

    if (startDate && endDate) {
      matchQuery.date = { $gte: startDate, $lte: endDate };
    } else if (startDate) {
      matchQuery.date = { $gte: startDate };
    } else if (endDate) {
      matchQuery.date = { $lte: endDate };
    }

    const project = await Project.findById(id);
    if (!project) return res.status(404).json({ success: false, message: "Project not found" });

    const results = await FollowUp.aggregate([
      { $match: matchQuery },
      { $unwind: "$evening.projects" },
      { $match: { "evening.projects.project": new mongoose.Types.ObjectId(id) } },
      {
        $group: {
          _id: "$user",
          totalMinutes: { $sum: "$evening.projects.totalMinutes" },
          lastActivity: { $max: "$date" }
        }
      },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "userDetails"
        }
      },
      { $unwind: "$userDetails" },
      {
        $project: {
          userId: "$_id",
          userName: "$userDetails.name",
          totalMinutes: 1,
          lastActivity: 1
        }
      },
      { $sort: { totalMinutes: -1 } }
    ]);

    const totalMinutes = results.reduce((acc, curr) => acc + curr.totalMinutes, 0);

    res.json({
      success: true,
      data: {
        project: {
          id: project._id,
          name: project.name,
          description: project.description
        },
        totalMinutes,
        totalContributors: results.length,
        contributors: results
      }
    });
  } catch (error) {
    console.error("Error in getProjectDetails:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

export const getUserDetails = async (req, res) => {
  try {
    const { id } = req.params;
    const { startDate, endDate } = req.query;

    const matchQuery = { status: { $in: ["submitted", "reviewed"] }, type: "evening", user: new mongoose.Types.ObjectId(id), "evening.projects": { $exists: true, $not: { $size: 0 } } };

    if (startDate && endDate) {
      matchQuery.date = { $gte: startDate, $lte: endDate };
    } else if (startDate) {
      matchQuery.date = { $gte: startDate };
    } else if (endDate) {
      matchQuery.date = { $lte: endDate };
    }

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    const results = await FollowUp.aggregate([
      { $match: matchQuery },
      { $unwind: "$evening.projects" },
      {
        $group: {
          _id: "$evening.projects.project",
          totalMinutes: { $sum: "$evening.projects.totalMinutes" }
        }
      },
      {
        $lookup: {
          from: "projects",
          localField: "_id",
          foreignField: "_id",
          as: "projectDetails"
        }
      },
      { $unwind: "$projectDetails" },
      {
        $project: {
          projectId: "$_id",
          projectName: "$projectDetails.name",
          totalMinutes: 1
        }
      },
      { $sort: { totalMinutes: -1 } }
    ]);

    const totalMinutes = results.reduce((acc, curr) => acc + curr.totalMinutes, 0);

    // Also get Daily Activity for chart
    const dailyActivity = await FollowUp.aggregate([
      { $match: matchQuery },
      { $unwind: "$evening.projects" },
      {
        $group: {
          _id: "$date",
          totalMinutes: { $sum: "$evening.projects.totalMinutes" }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    res.json({
      success: true,
      data: {
        user: {
          id: user._id,
          name: user.name
        },
        totalMinutes,
        totalProjects: results.length,
        projects: results,
        dailyActivity
      }
    });

  } catch (error) {
    console.error("Error in getUserDetails:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};
